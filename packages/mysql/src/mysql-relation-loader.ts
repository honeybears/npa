import {
  defaultQualifiedJoinTableName,
  EntityMetadata,
  findMappedOwningToOne,
  flattenRelationValues,
  flattenValueSets,
  getEntityMetadata,
  getCurrentPersistenceContext,
  groupRows,
  isOwningToOneRelation,
  keyForValueSet,
  NPADatabaseError,
  NPAMetadataError,
  NPALoadOptions,
  readColumnValueSet,
  readPrimaryValueSet,
  readValue,
  relationJoinColumns,
  RelationKind,
  RelationMetadata,
  requirePrimaryColumns,
  resolveManyToManyJoin,
  selectRelations,
  sourceAliasNames,
  uniqueValues,
  withEagerRelations,
  writeValue,
} from "@node-persistence-api/core/adapter";
import { executeMysqlQuery } from "./mysql-result";
import { MysqlQueryable } from "./types";

export async function loadMysqlRelations<TEntity extends object>(
  entities: TEntity[],
  options: {
    entity?: new (...args: any[]) => TEntity;
    queryable: MysqlQueryable;
    preferExecute?: boolean;
    load?: NPALoadOptions<TEntity>;
    eagerPath?: Array<new (...args: any[]) => object>;
  },
): Promise<TEntity[]> {
  if (entities.length === 0 || !options.load?.relations) {
    return entities;
  }

  if (!options.entity) {
    throw new NPAMetadataError("MySQL relation loading requires entity metadata.", {
      code: "NPA_RELATION_LOAD_METADATA_REQUIRED",
    });
  }

  const metadata = getEntityMetadata(options.entity);
  const eagerPath = [...(options.eagerPath ?? []), options.entity];
  const load = withEagerRelations(options.entity, options.load, options.eagerPath);
  const relationSelections = selectRelations(metadata, load?.relations ?? []);

  for (const { relation, nested } of relationSelections) {
    let loaded: object[];

    if (isOwningToOneRelation(relation)) {
      loaded = await loadManyToOne(entities, relation, options);
    } else if (relation.kind === RelationKind.ONE_TO_ONE) {
      loaded = await loadOneToOne(entities, metadata, relation, options);
    } else if (relation.kind === RelationKind.ONE_TO_MANY) {
      loaded = await loadOneToMany(entities, metadata, relation, options);
    } else if (relation.kind === RelationKind.MANY_TO_MANY) {
      loaded = await loadManyToMany(entities, metadata, relation, options);
    } else {
      loaded = [];
    }

    if (nested) {
      await loadMysqlRelations(loaded, {
        entity: relation.target() as new (...args: any[]) => object,
        load: { relations: nested },
        eagerPath,
        preferExecute: options.preferExecute,
        queryable: options.queryable,
      });
    }
  }

  return entities;
}

export function attachMysqlLazyRelations<TEntity extends object>(
  entities: TEntity[],
  options: {
    entity?: new (...args: any[]) => TEntity;
    preferExecute?: boolean;
    queryable: MysqlQueryable;
  },
): TEntity[] {
  if (entities.length === 0) {
    return entities;
  }

  if (!options.entity) {
    return entities;
  }

  const metadata = getEntityMetadata(options.entity);

  for (const entity of entities) {
    for (const relation of metadata.relations) {
      if (Object.prototype.hasOwnProperty.call(entity, relation.propertyName)) {
        continue;
      }

      let cached: Promise<unknown> | undefined;
      Object.defineProperty(entity, relation.propertyName, {
        configurable: true,
        enumerable: false,
        get() {
          cached ??= loadMysqlRelations([entity], {
            entity: options.entity,
            load: { relations: [relation.propertyName] },
            preferExecute: options.preferExecute,
            queryable: options.queryable,
          }).then(() => {
            getCurrentPersistenceContext()?.refreshRelationSnapshot(
              entity,
              relation.propertyName,
            );
            return readValue(entity, relation.propertyName);
          });

          return cached;
        },
        set(value: unknown) {
          cached = Promise.resolve(value);
          Object.defineProperty(entity, relation.propertyName, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
          });
        },
      });
    }
  }

  return entities;
}

async function loadManyToOne<TEntity extends object>(
  entities: TEntity[],
  relation: RelationMetadata,
  options: MysqlRelationLoadOptions<TEntity>,
): Promise<object[]> {
  const targetMetadata = getEntityMetadata(relation.target());
  const joinColumns = relationJoinColumns(relation);
  const ids = uniqueValues(entities.map((entity) =>
    readColumnValueSet(entity, joinColumns.map((column) => column.joinColumnName))));

  if (ids.length === 0) {
    for (const entity of entities) {
      writeValue(entity, relation.propertyName, null);
    }
    return [];
  }

  const rows = attachLazyTargets(
    await selectRowsByColumn(
      options,
      targetMetadata,
      joinColumns.map((column) => column.column.columnName),
      ids,
    ),
    relation,
    options,
  );
  const rowById = new Map(rows.map((row) => [
    keyForValueSet(readColumnValueSet(row, joinColumns.map((column) => column.column.columnName))),
    row,
  ]));

  for (const entity of entities) {
    const id = readColumnValueSet(entity, joinColumns.map((column) => column.joinColumnName));
    writeValue(entity, relation.propertyName, rowById.get(keyForValueSet(id)) ?? null);
  }

  return flattenRelationValues(entities, relation);
}

async function loadOneToOne<TEntity extends object>(
  entities: TEntity[],
  metadata: EntityMetadata,
  relation: RelationMetadata,
  options: MysqlRelationLoadOptions<TEntity>,
): Promise<object[]> {
  if (!relation.mappedBy) {
    throw new NPAMetadataError(`@OneToOne ${metadata.target.name}.${relation.propertyName} requires mappedBy.`, {
      code: "NPA_RELATION_MAPPED_BY_REQUIRED",
      details: { entity: metadata.target.name, relation: relation.propertyName },
    });
  }

  const targetMetadata = getEntityMetadata(relation.target());
  const targetRelation = findMappedOwningToOne(metadata, targetMetadata, relation);
  const sourceIds = uniqueValues(entities.map((entity) => readPrimaryValueSet(entity, metadata)));
  const joinColumns = relationJoinColumns(targetRelation);
  const rows = attachLazyTargets(
    await selectRowsByColumn(
      options,
      targetMetadata,
      joinColumns.map((column) => column.joinColumnName),
      sourceIds,
    ),
    relation,
    options,
  );
  const rowsBySourceId = groupRows(
    rows,
    joinColumns.map((column) => column.joinColumnName),
  );

  for (const entity of entities) {
    const id = readPrimaryValueSet(entity, metadata);
    writeValue(entity, relation.propertyName, rowsBySourceId.get(keyForValueSet(id))?.[0] ?? null);
  }

  return flattenRelationValues(entities, relation);
}

async function loadOneToMany<TEntity extends object>(
  entities: TEntity[],
  metadata: EntityMetadata,
  relation: RelationMetadata,
  options: MysqlRelationLoadOptions<TEntity>,
): Promise<object[]> {
  if (!relation.mappedBy) {
    throw new NPAMetadataError(`@OneToMany ${metadata.target.name}.${relation.propertyName} requires mappedBy.`, {
      code: "NPA_RELATION_MAPPED_BY_REQUIRED",
      details: { entity: metadata.target.name, relation: relation.propertyName },
    });
  }

  const targetMetadata = getEntityMetadata(relation.target());
  const targetRelation = targetMetadata.relations.find((candidate) =>
    candidate.kind === RelationKind.MANY_TO_ONE && candidate.propertyName === relation.mappedBy,
  );

  if (!targetRelation) {
    throw new NPAMetadataError(`@OneToMany ${metadata.target.name}.${relation.propertyName} mappedBy relation was not found.`, {
      code: "NPA_RELATION_MAPPED_BY_NOT_FOUND",
      details: { entity: metadata.target.name, relation: relation.propertyName, mappedBy: relation.mappedBy },
    });
  }

  const sourceIds = uniqueValues(entities.map((entity) => readPrimaryValueSet(entity, metadata)));
  const joinColumns = relationJoinColumns(targetRelation);
  const rows = attachLazyTargets(
    await selectRowsByColumn(
      options,
      targetMetadata,
      joinColumns.map((column) => column.joinColumnName),
      sourceIds,
    ),
    relation,
    options,
  );
  const rowsBySourceId = groupRows(
    rows,
    joinColumns.map((column) => column.joinColumnName),
  );

  for (const entity of entities) {
    const id = readPrimaryValueSet(entity, metadata);
    writeValue(entity, relation.propertyName, rowsBySourceId.get(keyForValueSet(id)) ?? []);
  }

  return flattenRelationValues(entities, relation);
}

function attachLazyTargets<TEntity extends object>(
  rows: Record<string, unknown>[],
  relation: RelationMetadata,
  options: MysqlRelationLoadOptions<TEntity>,
): Record<string, unknown>[] {
  return attachMysqlLazyRelations(rows, {
    entity: relation.target() as new (...args: any[]) => Record<string, unknown>,
    preferExecute: options.preferExecute,
    queryable: options.queryable,
  });
}

async function loadManyToMany<TEntity extends object>(
  entities: TEntity[],
  metadata: EntityMetadata,
  relation: RelationMetadata,
  options: MysqlRelationLoadOptions<TEntity>,
): Promise<object[]> {
  const targetMetadata = getEntityMetadata(relation.target());
  const sourceIds = uniqueValues(entities.map((entity) => readPrimaryValueSet(entity, metadata)));

  if (sourceIds.length === 0) {
    return [];
  }

  const join = resolveManyToManyJoin(metadata, relation, qualifiedJoinTable);
  const targetPrimaryColumns = requirePrimaryColumns(targetMetadata);
  const sourceColumns = relation.mappedBy ? join.targetColumns : join.sourceColumns;
  const targetColumns = relation.mappedBy ? join.sourceColumns : join.targetColumns;
  const sourceAliases = sourceAliasNames(sourceColumns);
  const sourceSelect = sourceColumns.map((column, index) =>
    `j.${quoteIdentifier(column)} AS ${quoteIdentifier(sourceAliases[index])}`);
  const targetJoinPredicate = targetPrimaryColumns.map((column, index) =>
    `t.${quoteIdentifier(column.columnName)} = j.${quoteIdentifier(targetColumns[index])}`)
    .join(" AND ");
  const placeholders = tuplePlaceholders(sourceIds);
  const result = await executeMysqlQuery<Record<string, unknown>>(
    options,
    [
      `SELECT ${sourceSelect.join(", ")}, t.*`,
      `FROM ${join.table} j`,
      `JOIN ${qualifiedTable(targetMetadata)} t ON ${targetJoinPredicate}`,
      `WHERE ${tupleExpression(sourceColumns, "j")} IN (${placeholders})`,
    ].join("\n"),
    flattenValueSets(sourceIds),
  );
  const rowsBySourceId = groupRows(
    result.rows,
    sourceAliases,
    { omitGroupColumns: true },
  );
  for (const rows of rowsBySourceId.values()) {
    attachLazyTargets(rows, relation, options);
  }

  for (const entity of entities) {
    const id = readPrimaryValueSet(entity, metadata);
    writeValue(entity, relation.propertyName, rowsBySourceId.get(keyForValueSet(id)) ?? []);
  }

  return flattenRelationValues(entities, relation);
}

async function selectRowsByColumn<TEntity extends object>(
  options: MysqlRelationLoadOptions<TEntity>,
  metadata: EntityMetadata,
  columnNames: string[],
  values: unknown[],
): Promise<Record<string, unknown>[]> {
  if (values.length === 0) {
    return [];
  }

  const result = await executeMysqlQuery<Record<string, unknown>>(
    options,
    `SELECT * FROM ${qualifiedTable(metadata)} WHERE ${tupleExpression(columnNames)} IN (${tuplePlaceholders(values)})`,
    flattenValueSets(values),
  );

  return result.rows;
}

interface MysqlRelationLoadOptions<TEntity extends object> {
  queryable: MysqlQueryable;
  preferExecute?: boolean;
  entity?: new (...args: any[]) => TEntity;
  load?: NPALoadOptions<TEntity>;
}

function qualifiedTable(metadata: EntityMetadata): string {
  const table = quoteQualifiedIdentifier(metadata.tableName);
  return metadata.schema ? `${quoteQualifiedIdentifier(metadata.schema)}.${table}` : table;
}

function qualifiedJoinTable(
  source: EntityMetadata,
  target: EntityMetadata,
  relation: RelationMetadata,
): string {
  return defaultQualifiedJoinTableName(source, target, relation, quoteQualifiedIdentifier);
}

function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new NPADatabaseError("MySQL identifier must not be empty.", {
      code: "NPA_DATABASE_IDENTIFIER_INVALID",
    });
  }

  return `\`${identifier.replace(/`/g, "``")}\``;
}

function tupleExpression(columns: string[], alias?: string): string {
  const qualified = columns.map((column) =>
    alias ? `${alias}.${quoteIdentifier(column)}` : quoteIdentifier(column));
  return qualified.length === 1 ? qualified[0] : `(${qualified.join(", ")})`;
}

function tuplePlaceholders(values: unknown[]): string {
  return values.map((value) => {
    if (!Array.isArray(value)) {
      return "?";
    }

    return `(${value.map(() => "?").join(", ")})`;
  }).join(", ");
}
