import {
  CascadeType,
  ColumnMetadata,
  EntityMetadata,
  RelationKind,
  RelationMetadata,
} from "./types";
import { NPAMetadataError } from "../error";
import { getEntityMetadata } from "./metadata-storage";
import { toSnakeCase } from "./naming";

export interface RelationLoadTree {
  [propertyName: string]: true | RelationLoadTree;
}

export interface RelationJoinColumn {
  column: ColumnMetadata;
  joinColumnName: string;
}

export function relationJoinColumnName(relation: RelationMetadata): string {
  const joinColumns = relationJoinColumns(relation);

  if (joinColumns.length !== 1) {
    throw new Error(
      `Relation ${relation.propertyName} targets a composite @Id. Use relationJoinColumns() instead.`,
    );
  }

  return joinColumns[0].joinColumnName;
}

export function relationJoinColumns(relation: RelationMetadata): RelationJoinColumn[] {
  const targetMetadata = getEntityMetadata(relation.target());
  const targetPrimaryColumns = requirePrimaryColumns(targetMetadata, `Relation ${relation.propertyName}`);
  const explicit = relation.joinColumns ?? (
    relation.joinColumn ? [relation.joinColumn] : undefined
  );

  if (explicit && explicit.length !== targetPrimaryColumns.length) {
    throw new Error(
      `Relation ${relation.propertyName} defines ${explicit.length} join column(s), but ${targetMetadata.target.name} has ${targetPrimaryColumns.length} @Id column(s).`,
    );
  }

  return targetPrimaryColumns.map((column, index) => ({
    column,
    joinColumnName: explicit?.[index] ?? `${relation.propertyName}_${column.columnName}`,
  }));
}

export function readRelationForeignKeyValue(
  value: unknown,
  relation: RelationMetadata,
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  const targetMetadata = getEntityMetadata(relation.target());
  const record = value as Record<string, unknown>;
  const targetPrimaryColumns = requirePrimaryColumns(targetMetadata, `Relation ${relation.propertyName}`);

  if (targetPrimaryColumns.length > 1) {
    return Object.fromEntries(targetPrimaryColumns.map((primaryColumn) => [
      primaryColumn.propertyName,
      readRequiredRelationPrimaryValue(record, relation, targetMetadata, primaryColumn),
    ]));
  }

  const targetPrimaryColumn = targetPrimaryColumns[0];

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

  throw new NPAMetadataError(
    `Relation ${relation.propertyName} requires ${targetMetadata.target.name}.${targetPrimaryColumn.propertyName} or ${targetPrimaryColumn.columnName}.`,
    {
      code: "NPA_RELATION_PRIMARY_VALUE_REQUIRED",
      details: {
        relation: relation.propertyName,
        targetName: targetMetadata.target.name,
      },
    },
  );
}

export function readEntityPrimaryValue(
  entity: object,
  metadata: EntityMetadata,
): unknown {
  const primaryColumns = primaryColumnsOf(metadata);

  if (primaryColumns.length === 0) {
    throw new NPAMetadataError(`Entity ${metadata.target.name} requires an @Id column.`, {
      code: "NPA_ENTITY_ID_REQUIRED",
      details: { entityName: metadata.target.name },
    });
  }

  const record = entity as Record<string, unknown>;

  if (primaryColumns.length > 1) {
    return Object.fromEntries(primaryColumns.map((primaryColumn) => [
      primaryColumn.propertyName,
      primaryColumn.propertyName in record
        ? record[primaryColumn.propertyName]
        : record[primaryColumn.columnName],
    ]));
  }

  const primaryColumn = primaryColumns[0];

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

export function joinTableColumnNames(
  entity: EntityMetadata,
): RelationJoinColumn[] {
  const primaryColumns = requirePrimaryColumns(entity, `Entity ${entity.target.name}`);
  const prefix = `${toSnakeCase(entity.target.name)}_`;

  return primaryColumns.map((column) => ({
    column,
    joinColumnName: column.columnName.startsWith(prefix)
      ? column.columnName
      : `${prefix}${column.columnName}`,
  }));
}

export function primaryColumnsOf(metadata: EntityMetadata): ColumnMetadata[] {
  return metadata.primaryColumns.length > 0
    ? metadata.primaryColumns
    : metadata.primaryColumn
      ? [metadata.primaryColumn]
      : [];
}

export function needsOrmDelete(metadata: EntityMetadata): boolean {
  return metadata.relations.some((relation) =>
    relation.kind === RelationKind.MANY_TO_MANY ||
    ((relation.kind === RelationKind.ONE_TO_MANY ||
      relation.kind === RelationKind.ONE_TO_ONE) && relation.orphanRemoval) ||
    relation.cascade.includes(CascadeType.REMOVE),
  );
}

export function removeCascadeRelationTree(
  metadata: EntityMetadata,
  seen = new Set<object>(),
): RelationLoadTree | undefined {
  if (seen.has(metadata.target)) {
    return undefined;
  }

  seen.add(metadata.target);

  const tree: RelationLoadTree = {};

  for (const relation of metadata.relations) {
    if (
      !((relation.kind === RelationKind.ONE_TO_MANY ||
        relation.kind === RelationKind.ONE_TO_ONE) && relation.orphanRemoval) &&
      !relation.cascade.includes(CascadeType.REMOVE)
    ) {
      continue;
    }

    const targetTree = removeCascadeRelationTree(
      getEntityMetadata(relation.target()),
      new Set(seen),
    );
    tree[relation.propertyName] = targetTree ?? true;
  }

  return Object.keys(tree).length === 0 ? undefined : tree;
}

function requirePrimaryColumns(
  metadata: EntityMetadata,
  context: string,
): ColumnMetadata[] {
  const primaryColumns = primaryColumnsOf(metadata);

  if (primaryColumns.length === 0) {
    throw new NPAMetadataError(`${context} targets entity ${metadata.target.name} without an @Id column.`, {
      code: "NPA_RELATION_TARGET_ID_REQUIRED",
      details: { context, entityName: metadata.target.name },
    });
  }

  return primaryColumns;
}

function readRequiredRelationPrimaryValue(
  record: Record<string, unknown>,
  relation: RelationMetadata,
  targetMetadata: EntityMetadata,
  primaryColumn: ColumnMetadata,
): unknown {
  if (primaryColumn.propertyName in record) {
    return requireRelationPrimaryValue(
      relation,
      targetMetadata,
      primaryColumn.propertyName,
      record[primaryColumn.propertyName],
    );
  }

  if (primaryColumn.columnName in record) {
    return requireRelationPrimaryValue(
      relation,
      targetMetadata,
      primaryColumn.columnName,
      record[primaryColumn.columnName],
    );
  }

  throw new NPAMetadataError(
    `Relation ${relation.propertyName} requires ${targetMetadata.target.name}.${primaryColumn.propertyName} or ${primaryColumn.columnName}.`,
    {
      code: "NPA_RELATION_PRIMARY_VALUE_REQUIRED",
      details: {
        relation: relation.propertyName,
        targetName: targetMetadata.target.name,
        propertyName: primaryColumn.propertyName,
        columnName: primaryColumn.columnName,
      },
    },
  );
}

function requireRelationPrimaryValue(
  relation: RelationMetadata,
  targetMetadata: EntityMetadata,
  propertyName: string,
  value: unknown,
): unknown {
  if (value === null || value === undefined) {
    throw new NPAMetadataError(
      `Relation ${relation.propertyName} requires ${targetMetadata.target.name}.${propertyName}.`,
      {
        code: "NPA_RELATION_PRIMARY_VALUE_REQUIRED",
        details: {
          relation: relation.propertyName,
          targetName: targetMetadata.target.name,
          propertyName,
        },
      },
    );
  }

  return value;
}
