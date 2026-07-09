import {
  defaultJoinTableName,
  getEntityMetadata,
  getOptionalEntityMetadata,
  joinTableColumnNames,
  primaryColumnsOf,
  RelationKind,
} from "../entity";
import type {
  ColumnMetadata,
  EntityMetadata,
  EntityTarget,
  RelationMetadata,
} from "../entity";
import { NPAMetadataError, NPAPersistenceError, NPAQueryError } from "../error";
import type { NPAEntityGraphMetadata } from "./entity-graph-decorator";
import type { NPARelationLoadTree } from "./relation-load-types";
import type {
  NPAFindOptions,
  NPALoadOptions,
  RepositoryMethodInvocation,
} from "./types";

export interface ManyToManyJoin {
  table: string;
  sourceColumns: string[];
  targetColumns: string[];
}

export function firstColumn(row: object | null): unknown {
  if (!row) {
    return null;
  }

  const [value] = Object.values(row);
  return value ?? null;
}

export function selectRelations(
  metadata: EntityMetadata,
  requested: NonNullable<NPALoadOptions["relations"]>,
): Array<{ relation: RelationMetadata; nested?: NPARelationLoadTree }> {
  if (requested === true) {
    return metadata.relations.map((relation) => ({ relation }));
  }

  if (Array.isArray(requested)) {
    return requested.map((propertyName) => ({
      relation: findRelation(metadata, propertyName),
    }));
  }

  const relationTree = requested as Record<string, true | NPARelationLoadTree>;

  return Object.entries(relationTree).map(([propertyName, nested]) => ({
    relation: findRelation(metadata, propertyName),
    nested: nested === true ? undefined : nested,
  }));
}

export function findRelation(
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

export function flattenRelationValues(
  entities: object[],
  relation: RelationMetadata,
): object[] {
  return entities.flatMap((entity) => {
    const value = readValue(entity, relation.propertyName);
    return Array.isArray(value) ? value : value ? [value] : [];
  }) as object[];
}

export function findMappedOwningToOne(
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

export function isOwningToOneRelation(relation: RelationMetadata): boolean {
  return relation.kind === RelationKind.MANY_TO_ONE ||
    (relation.kind === RelationKind.ONE_TO_ONE && !relation.mappedBy);
}

export function groupRows(
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

export function omitProperties(
  row: Record<string, unknown>,
  propertyNames: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !propertyNames.includes(key)),
  );
}

export function requirePrimaryColumns(metadata: EntityMetadata): ColumnMetadata[] {
  const primaryColumns = primaryColumnsOf(metadata);

  if (primaryColumns.length === 0) {
    throw new NPAMetadataError(`Entity ${metadata.target.name} requires an @Id column.`, {
      code: "NPA_ENTITY_ID_REQUIRED",
      details: { entity: metadata.target.name },
    });
  }

  return primaryColumns;
}

export function uniqueValues(values: unknown[]): unknown[] {
  const unique = new Map<string, unknown>();

  for (const value of values) {
    if (!hasCompleteValueSet(value)) {
      continue;
    }

    unique.set(keyForValueSet(value), value);
  }

  return [...unique.values()];
}

export function readValue(entity: object, propertyOrColumn: string): unknown {
  return (entity as Record<string, unknown>)[propertyOrColumn];
}

export function writeValue(entity: object, propertyName: string, value: unknown): void {
  (entity as Record<string, unknown>)[propertyName] = value;
}

export function readColumnValueSet(entity: object, columns: string[]): unknown {
  if (columns.length === 1) {
    return readValue(entity, columns[0]);
  }

  const record = entity as Record<string, unknown>;
  return columns.map((column) => record[column]);
}

export function readPrimaryValueSet(entity: object, metadata: EntityMetadata): unknown {
  const columns = requirePrimaryColumns(metadata);

  if (columns.length === 1) {
    return readValue(entity, columns[0].propertyName) ??
      readValue(entity, columns[0].columnName);
  }

  return columns.map((column) =>
    readValue(entity, column.propertyName) ?? readValue(entity, column.columnName));
}

export function hasCompleteValueSet(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (!Array.isArray(value)) {
    return true;
  }

  return value.every((part) => part !== null && part !== undefined);
}

export function keyForValueSet(value: unknown): string {
  if (!Array.isArray(value)) {
    return `${typeof value}:${String(value)}`;
  }

  return JSON.stringify(value);
}

export function flattenValueSets(values: unknown[]): unknown[] {
  return values.flatMap((value) => Array.isArray(value)
    ? value
    : [value]);
}

export function sourceAlias(columnName: string): string {
  return `__source_${columnName}`;
}

export function sourceAliasNames(columnNames: string[]): string[] {
  return columnNames.length === 1 ? ["__source_id"] : columnNames.map(sourceAlias);
}

export function resolveManyToManyJoin(
  source: EntityMetadata,
  relation: RelationMetadata,
  qualifiedJoinTable: (
    source: EntityMetadata,
    target: EntityMetadata,
    relation: RelationMetadata,
  ) => string,
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

export function defaultQualifiedJoinTableName(
  source: EntityMetadata,
  target: EntityMetadata,
  relation: RelationMetadata,
  quoteQualifiedIdentifier: (identifier: string) => string,
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

export function compileTupleWhere(
  columns: string[],
  id: unknown,
  idColumns: ColumnMetadata[],
  options: {
    quoteIdentifier: (identifier: string) => string;
    placeholder: (index: number) => string;
    startIndex?: number;
  },
): { sql: string; values: unknown[] } {
  const values = idParts(id, idColumns);
  const startIndex = options.startIndex ?? 1;

  if (columns.length !== values.length) {
    throw new NPAPersistenceError(
      `Expected ${columns.length} id value(s), received ${values.length}.`,
      {
        code: "NPA_COMPOSITE_ID_OBJECT_REQUIRED",
        details: {
          actualValues: values.length,
          expectedValues: columns.length,
        },
      },
    );
  }

  if (columns.length === 1) {
    return {
      sql: `${options.quoteIdentifier(columns[0])} = ${options.placeholder(startIndex)}`,
      values,
    };
  }

  return {
    sql: `(${columns.map(options.quoteIdentifier).join(", ")}) = (${values.map((_, index) => options.placeholder(startIndex + index)).join(", ")})`,
    values,
  };
}

export function idParts(id: unknown, columns: ColumnMetadata[] = []): unknown[] {
  if (columns.length > 0) {
    if (columns.length === 1 && !isRecord(id)) {
      return [id];
    }

    if (!isRecord(id)) {
      throw new NPAPersistenceError(
        `Expected object id with ${columns.length} value(s), received scalar id.`,
        {
          code: "NPA_COMPOSITE_ID_OBJECT_REQUIRED",
          details: { expectedValues: columns.length, id },
        },
      );
    }

    return columns.map((column) =>
      column.propertyName in id ? id[column.propertyName] : id[column.columnName]);
  }

  if (!isRecord(id)) {
    return [id];
  }

  return Object.keys(id).sort().map((key) => id[key]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireAdapterMetadata<TEntity extends object>(
  entity: EntityTarget<TEntity> | undefined,
  adapter: string,
  operation: string,
): EntityMetadata {
  if (!entity) {
    throw new NPAMetadataError(`${adapter} ${operation} requires entity metadata.`, {
      code: "NPA_REPOSITORY_METADATA_REQUIRED",
      details: { operation },
    });
  }

  return getEntityMetadata(entity);
}

export function toEntityGraphLoad<TEntity extends object>(
  entityGraph: NPAEntityGraphMetadata<TEntity> | undefined,
): NPALoadOptions<TEntity> | undefined {
  return entityGraph ? { relations: entityGraph.relations } : undefined;
}

export function findAllInvocation<TEntity extends object>(
  load: NPAFindOptions<TEntity> | undefined,
): RepositoryMethodInvocation {
  return {
    query: {
      methodName: "findAll",
      action: "find",
      predicate: [],
      orderBy: (load?.orderBy ?? []).map((order) => ({
        property: order.property,
        direction: normalizeOrderDirection(order.direction),
      })),
      parameterCount: 0,
    },
    args: [],
    pageable: load?.pageable,
  };
}

export function normalizeOrderDirection(direction: unknown): "asc" | "desc" {
  if (direction === undefined) {
    return "asc";
  }

  if (direction === "asc" || direction === "desc") {
    return direction;
  }

  throw new NPAQueryError(`Unsupported order direction "${String(direction)}".`, {
    code: "NPA_ORDER_DIRECTION_UNSUPPORTED",
    details: { direction },
  });
}

export function readExpectedVersionFromPatch(
  patch: object,
  entity: EntityTarget | undefined,
): unknown {
  const versionColumn = getOptionalEntityMetadata(entity)?.versionColumn;

  if (!versionColumn) {
    return undefined;
  }

  const record = patch as Record<string, unknown>;

  if (versionColumn.propertyName in record) {
    return record[versionColumn.propertyName];
  }

  if (versionColumn.columnName in record) {
    return record[versionColumn.columnName];
  }

  return undefined;
}
