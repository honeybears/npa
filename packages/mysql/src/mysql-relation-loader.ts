import {
  defaultJoinTableName,
  EntityMetadata,
  getEntityMetadata,
  getCurrentPersistenceContext,
  NPADatabaseError,
  NPAMetadataError,
  NPALoadOptions,
  NPARelationLoadTree,
  primaryColumnsOf,
  relationJoinColumns,
  RelationKind,
  RelationMetadata,
  joinTableColumnNames,
  withEagerRelations,
} from "@node-persistence-api/core";
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

function selectRelations(
  metadata: EntityMetadata,
  requested: NonNullable<NPALoadOptions["relations"]>,
): Array<{ relation: RelationMetadata; nested?: NPARelationLoadTree }> {
  if (requested === true) {
    return metadata.relations.map((relation) => ({ relation }));
  }

  if (Array.isArray(requested)) {
    return requested.map((propertyName) => {
      const relation = findRelation(metadata, propertyName);

      return { relation };
    });
  }

  const relationTree = requested as Record<string, true | NPARelationLoadTree>;

  return Object.entries(relationTree).map(([propertyName, nested]) => {
    const relation = findRelation(metadata, propertyName);

    return {
      relation,
      nested: nested === true ? undefined : nested,
    };
  });
}

function findRelation(
  metadata: EntityMetadata,
  propertyName: string,
): RelationMetadata {
    const relation = metadata.relations.find((candidate) =>
      candidate.propertyName === propertyName,
    );

    if (!relation) {
      throw new NPAMetadataError(`Entity ${metadata.target.name} has no relation ${propertyName}.`, {
        code: "NPA_RELATION_NOT_FOUND",
        details: { entity: metadata.target.name, relation: propertyName },
      });
    }

    return relation;
}

function flattenRelationValues(entities: object[], relation: RelationMetadata): object[] {
  return entities.flatMap((entity) => {
    const value = readValue(entity, relation.propertyName);
    return Array.isArray(value) ? value : value ? [value] : [];
  }) as object[];
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

function findMappedOwningToOne(
  sourceMetadata: EntityMetadata,
  targetMetadata: EntityMetadata,
  relation: RelationMetadata,
): RelationMetadata {
  const targetRelation = targetMetadata.relations.find((candidate) =>
    isOwningToOneRelation(candidate) && candidate.propertyName === relation.mappedBy,
  );

  if (!targetRelation) {
    throw new NPAMetadataError(`@OneToOne ${sourceMetadata.target.name}.${relation.propertyName} mappedBy relation was not found.`, {
      code: "NPA_RELATION_MAPPED_BY_NOT_FOUND",
      details: { entity: sourceMetadata.target.name, relation: relation.propertyName, mappedBy: relation.mappedBy },
    });
  }

  return targetRelation;
}

function isOwningToOneRelation(relation: RelationMetadata): boolean {
  return relation.kind === RelationKind.MANY_TO_ONE ||
    (relation.kind === RelationKind.ONE_TO_ONE && !relation.mappedBy);
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

  const join = manyToManyJoin(metadata, relation);
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

interface ManyToManyJoin {
  table: string;
  sourceColumns: string[];
  targetColumns: string[];
}

function manyToManyJoin(
  source: EntityMetadata,
  relation: RelationMetadata,
): ManyToManyJoin {
  const target = getEntityMetadata(relation.target());

  if (relation.mappedBy) {
    const owner = target.relations.find((candidate) =>
      candidate.kind === RelationKind.MANY_TO_MANY &&
      candidate.propertyName === relation.mappedBy,
    );

    if (!owner) {
      throw new NPAMetadataError(`@ManyToMany ${source.target.name}.${relation.propertyName} mappedBy relation was not found.`, {
        code: "NPA_RELATION_MAPPED_BY_NOT_FOUND",
        details: { entity: source.target.name, relation: relation.propertyName, mappedBy: relation.mappedBy },
      });
    }

    return {
      table: qualifiedJoinTable(target, source, owner),
      sourceColumns: joinTableColumnNames(target).map((column) => column.joinColumnName),
      targetColumns: joinTableColumnNames(source).map((column) => column.joinColumnName),
    };
  }

  return {
    table: qualifiedJoinTable(source, target, relation),
    sourceColumns: joinTableColumnNames(source).map((column) => column.joinColumnName),
    targetColumns: joinTableColumnNames(target).map((column) => column.joinColumnName),
  };
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

function groupRows(
  rows: Record<string, unknown>[],
  columnNames: string[],
  options: { omitGroupColumns?: boolean } = {},
): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();

  for (const row of rows) {
    const key = keyForValueSet(readColumnValueSet(row, columnNames));
    const current = grouped.get(key) ?? [];
    current.push(options.omitGroupColumns ? omitProperties(row, columnNames) : row);
    grouped.set(key, current);
  }

  return grouped;
}

function omitProperties(
  row: Record<string, unknown>,
  propertyNames: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !propertyNames.includes(key)),
  );
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
  const rawName = relation.joinTable ?? defaultJoinTableName(source, target);
  const separatorIndex = rawName.indexOf(".");

  if (separatorIndex > 0) {
    return `${quoteQualifiedIdentifier(rawName.slice(0, separatorIndex))}.${quoteQualifiedIdentifier(rawName.slice(separatorIndex + 1))}`;
  }

  const table = quoteQualifiedIdentifier(rawName);
  const schema = source.schema ?? target.schema;
  return schema ? `${quoteQualifiedIdentifier(schema)}.${table}` : table;
}

function requirePrimaryColumns(metadata: EntityMetadata) {
  const primaryColumns = primaryColumnsOf(metadata);

  if (primaryColumns.length === 0) {
    throw new NPAMetadataError(`Entity ${metadata.target.name} requires an @Id column.`, {
      code: "NPA_ENTITY_ID_REQUIRED",
      details: { entity: metadata.target.name },
    });
  }

  return primaryColumns;
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

function uniqueValues(values: unknown[]): unknown[] {
  const unique = new Map<string, unknown>();

  for (const value of values) {
    if (!hasCompleteValueSet(value)) {
      continue;
    }

    unique.set(keyForValueSet(value), value);
  }

  return [...unique.values()];
}

function readValue(entity: object, propertyOrColumn: string): unknown {
  return (entity as Record<string, unknown>)[propertyOrColumn];
}

function writeValue(entity: object, propertyName: string, value: unknown): void {
  (entity as Record<string, unknown>)[propertyName] = value;
}

function readColumnValueSet(entity: object, columns: string[]): unknown {
  if (columns.length === 1) {
    return readValue(entity, columns[0]);
  }

  const record = entity as Record<string, unknown>;
  return columns.map((column) => record[column]);
}

function readPrimaryValueSet(entity: object, metadata: EntityMetadata): unknown {
  const columns = requirePrimaryColumns(metadata);

  if (columns.length === 1) {
    return readValue(entity, columns[0].propertyName) ??
      readValue(entity, columns[0].columnName);
  }

  return columns.map((column) =>
    readValue(entity, column.propertyName) ?? readValue(entity, column.columnName));
}

function hasCompleteValueSet(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (!Array.isArray(value)) {
    return true;
  }

  return value.every((part) => part !== null && part !== undefined);
}

function keyForValueSet(value: unknown): string {
  if (!Array.isArray(value)) {
    return `${typeof value}:${String(value)}`;
  }

  return JSON.stringify(value);
}

function flattenValueSets(values: unknown[]): unknown[] {
  return values.flatMap((value) => Array.isArray(value) ? value : [value]);
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

function sourceAlias(columnName: string): string {
  return `__source_${columnName}`;
}

function sourceAliasNames(columnNames: string[]): string[] {
  return columnNames.length === 1 ? ["__source_id"] : columnNames.map(sourceAlias);
}
