import {
  defaultJoinTableName,
  EntityMetadata,
  getEntityMetadata,
  NPALoadOptions,
  readEntityPrimaryValue,
  relationJoinColumnName,
  RelationMetadata,
  joinTableColumnName,
} from "@honeybeaers/npa";
import { executeMysqlQuery } from "./mysql-result";
import { MysqlQueryable } from "./types";

export async function loadMysqlRelations<TEntity extends object>(
  entities: TEntity[],
  options: {
    entity?: new (...args: any[]) => TEntity;
    queryable: MysqlQueryable;
    preferExecute?: boolean;
    load?: NPALoadOptions<TEntity>;
  },
): Promise<TEntity[]> {
  if (entities.length === 0 || !options.load?.relations) {
    return entities;
  }

  if (!options.entity) {
    throw new Error("MySQL relation loading requires entity metadata.");
  }

  const metadata = getEntityMetadata(options.entity);
  const relations = selectRelations(metadata, options.load.relations);

  for (const relation of relations) {
    if (relation.kind === "many-to-one") {
      await loadManyToOne(entities, relation, options);
    } else if (relation.kind === "one-to-many") {
      await loadOneToMany(entities, metadata, relation, options);
    } else if (relation.kind === "many-to-many") {
      await loadManyToMany(entities, metadata, relation, options);
    }
  }

  return entities;
}

function selectRelations(
  metadata: EntityMetadata,
  requested: true | string[],
): RelationMetadata[] {
  if (requested === true) {
    return metadata.relations;
  }

  return requested.map((propertyName) => {
    const relation = metadata.relations.find((candidate) =>
      candidate.propertyName === propertyName,
    );

    if (!relation) {
      throw new Error(`Entity ${metadata.target.name} has no relation ${propertyName}.`);
    }

    return relation;
  });
}

async function loadManyToOne<TEntity extends object>(
  entities: TEntity[],
  relation: RelationMetadata,
  options: MysqlRelationLoadOptions<TEntity>,
): Promise<void> {
  const targetMetadata = getEntityMetadata(relation.target());
  const targetPrimary = requirePrimaryColumn(targetMetadata);
  const joinColumn = relationJoinColumnName(relation);
  const ids = uniqueValues(entities.map((entity) => readValue(entity, joinColumn)));

  if (ids.length === 0) {
    for (const entity of entities) {
      writeValue(entity, relation.propertyName, null);
    }
    return;
  }

  const rows = await selectRowsByColumn(options, targetMetadata, targetPrimary.columnName, ids);
  const rowById = new Map(rows.map((row) => [readValue(row, targetPrimary.columnName), row]));

  for (const entity of entities) {
    const id = readValue(entity, joinColumn);
    writeValue(entity, relation.propertyName, rowById.get(id) ?? null);
  }
}

async function loadOneToMany<TEntity extends object>(
  entities: TEntity[],
  metadata: EntityMetadata,
  relation: RelationMetadata,
  options: MysqlRelationLoadOptions<TEntity>,
): Promise<void> {
  if (!relation.mappedBy) {
    throw new Error(`@OneToMany ${metadata.target.name}.${relation.propertyName} requires mappedBy.`);
  }

  const targetMetadata = getEntityMetadata(relation.target());
  const targetRelation = targetMetadata.relations.find((candidate) =>
    candidate.kind === "many-to-one" && candidate.propertyName === relation.mappedBy,
  );

  if (!targetRelation) {
    throw new Error(`@OneToMany ${metadata.target.name}.${relation.propertyName} mappedBy relation was not found.`);
  }

  const sourceIds = uniqueValues(entities.map((entity) => readEntityPrimaryValue(entity, metadata)));
  const joinColumn = relationJoinColumnName(targetRelation);
  const rows = await selectRowsByColumn(options, targetMetadata, joinColumn, sourceIds);
  const rowsBySourceId = groupRows(rows, joinColumn);

  for (const entity of entities) {
    const id = readEntityPrimaryValue(entity, metadata);
    writeValue(entity, relation.propertyName, rowsBySourceId.get(id) ?? []);
  }
}

async function loadManyToMany<TEntity extends object>(
  entities: TEntity[],
  metadata: EntityMetadata,
  relation: RelationMetadata,
  options: MysqlRelationLoadOptions<TEntity>,
): Promise<void> {
  const targetMetadata = getEntityMetadata(relation.target());
  const sourceIds = uniqueValues(entities.map((entity) => readEntityPrimaryValue(entity, metadata)));

  if (sourceIds.length === 0) {
    return;
  }

  const targetPrimary = requirePrimaryColumn(targetMetadata);
  const sourceColumn = joinTableColumnName(metadata);
  const targetColumn = joinTableColumnName(targetMetadata);
  const placeholders = sourceIds.map(() => "?").join(", ");
  const result = await executeMysqlQuery<Record<string, unknown>>(
    options,
    [
      `SELECT j.${quoteIdentifier(sourceColumn)} AS \`__npa_source_id\`, t.*`,
      `FROM ${qualifiedJoinTable(metadata, targetMetadata, relation)} j`,
      `JOIN ${qualifiedTable(targetMetadata)} t ON t.${quoteIdentifier(targetPrimary.columnName)} = j.${quoteIdentifier(targetColumn)}`,
      `WHERE j.${quoteIdentifier(sourceColumn)} IN (${placeholders})`,
    ].join("\n"),
    sourceIds,
  );
  const rowsBySourceId = groupRows(result.rows, "__npa_source_id", {
    omitGroupColumn: true,
  });

  for (const entity of entities) {
    const id = readEntityPrimaryValue(entity, metadata);
    writeValue(entity, relation.propertyName, rowsBySourceId.get(id) ?? []);
  }
}

async function selectRowsByColumn<TEntity extends object>(
  options: MysqlRelationLoadOptions<TEntity>,
  metadata: EntityMetadata,
  columnName: string,
  values: unknown[],
): Promise<Record<string, unknown>[]> {
  if (values.length === 0) {
    return [];
  }

  const placeholders = values.map(() => "?").join(", ");
  const result = await executeMysqlQuery<Record<string, unknown>>(
    options,
    `SELECT * FROM ${qualifiedTable(metadata)} WHERE ${quoteIdentifier(columnName)} IN (${placeholders})`,
    values,
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
  columnName: string,
  options: { omitGroupColumn?: boolean } = {},
): Map<unknown, Record<string, unknown>[]> {
  const grouped = new Map<unknown, Record<string, unknown>[]>();

  for (const row of rows) {
    const key = readValue(row, columnName);
    const current = grouped.get(key) ?? [];
    current.push(options.omitGroupColumn ? omitProperty(row, columnName) : row);
    grouped.set(key, current);
  }

  return grouped;
}

function omitProperty(
  row: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> {
  const { [propertyName]: _omitted, ...rest } = row;
  return rest;
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

function requirePrimaryColumn(metadata: EntityMetadata) {
  if (!metadata.primaryColumn) {
    throw new Error(`Entity ${metadata.target.name} requires an @Id column.`);
  }

  return metadata.primaryColumn;
}

function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new Error("MySQL identifier must not be empty.");
  }

  return `\`${identifier.replace(/`/g, "``")}\``;
}

function uniqueValues(values: unknown[]): unknown[] {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

function readValue(entity: object, propertyOrColumn: string): unknown {
  return (entity as Record<string, unknown>)[propertyOrColumn];
}

function writeValue(entity: object, propertyName: string, value: unknown): void {
  (entity as Record<string, unknown>)[propertyName] = value;
}
