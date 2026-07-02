import { EntityMetadata, RelationMetadata } from "./types";
import { getEntityMetadata } from "./metadata-storage";

export function relationJoinColumnName(relation: RelationMetadata): string {
  const targetMetadata = getEntityMetadata(relation.target());
  const targetPrimaryColumn = targetMetadata.primaryColumn;

  if (!targetPrimaryColumn) {
    throw new Error(
      `Relation ${relation.propertyName} targets entity ${targetMetadata.target.name} without an @Id column.`,
    );
  }

  return relation.joinColumn ?? `${relation.propertyName}_${targetPrimaryColumn.columnName}`;
}

export function readRelationForeignKeyValue(
  value: unknown,
  relation: RelationMetadata,
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  const targetMetadata = getEntityMetadata(relation.target());
  const targetPrimaryColumn = targetMetadata.primaryColumn;

  if (!targetPrimaryColumn) {
    throw new Error(
      `Relation ${relation.propertyName} targets entity ${targetMetadata.target.name} without an @Id column.`,
    );
  }

  const record = value as Record<string, unknown>;

  if (targetPrimaryColumn.propertyName in record) {
    return requireRelationPrimaryValue(
      relation,
      targetMetadata,
      targetPrimaryColumn.propertyName,
      record[targetPrimaryColumn.propertyName],
    );
  }

  if (targetPrimaryColumn.columnName in record) {
    return requireRelationPrimaryValue(
      relation,
      targetMetadata,
      targetPrimaryColumn.columnName,
      record[targetPrimaryColumn.columnName],
    );
  }

  throw new Error(
    `Relation ${relation.propertyName} requires ${targetMetadata.target.name}.${targetPrimaryColumn.propertyName} or ${targetPrimaryColumn.columnName}.`,
  );
}

export function readEntityPrimaryValue(
  entity: object,
  metadata: EntityMetadata,
): unknown {
  const primaryColumn = metadata.primaryColumn;

  if (!primaryColumn) {
    throw new Error(`Entity ${metadata.target.name} requires an @Id column.`);
  }

  const record = entity as Record<string, unknown>;

  if (primaryColumn.propertyName in record) {
    return record[primaryColumn.propertyName];
  }

  return record[primaryColumn.columnName];
}

export function defaultJoinTableName(
  source: EntityMetadata,
  target: EntityMetadata,
): string {
  return `${source.tableName}_${target.tableName}`;
}

export function joinTableColumnName(
  entity: EntityMetadata,
): string {
  const primaryColumn = entity.primaryColumn;

  if (!primaryColumn) {
    throw new Error(`Entity ${entity.target.name} requires an @Id column.`);
  }

  const prefix = `${toSnakeCase(entity.target.name)}_`;

  return primaryColumn.columnName.startsWith(prefix)
    ? primaryColumn.columnName
    : `${prefix}${primaryColumn.columnName}`;
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match, index) =>
    `${index === 0 ? "" : "_"}${match.toLowerCase()}`,
  );
}

function requireRelationPrimaryValue(
  relation: RelationMetadata,
  targetMetadata: EntityMetadata,
  propertyName: string,
  value: unknown,
): unknown {
  if (value === null || value === undefined) {
    throw new Error(
      `Relation ${relation.propertyName} requires ${targetMetadata.target.name}.${propertyName}.`,
    );
  }

  return value;
}
