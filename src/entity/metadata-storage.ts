import {
  CascadeType,
  ColumnMetadata,
  ColumnOptions,
  EntityMetadata,
  EntityOptions,
  EntityTarget,
  IndexMetadata,
  IndexOptions,
  RelationKind,
  RelationMetadata,
  RelationOptions,
} from "./types";

interface MutableEntityMetadata {
  target: EntityTarget;
  tableName?: string;
  schema?: string;
  columns: Map<string, ColumnMetadata>;
  indexes: Map<string, IndexMetadata>;
  relations: Map<string, RelationMetadata>;
  primaryColumn?: ColumnMetadata;
  primaryColumns: Map<string, ColumnMetadata>;
  versionColumn?: ColumnMetadata;
  createdAtColumn?: ColumnMetadata;
  updatedAtColumn?: ColumnMetadata;
}

const metadataByTarget = new WeakMap<EntityTarget, MutableEntityMetadata>();

export function registerEntity(
  target: EntityTarget,
  options: EntityOptions = {},
): void {
  const metadata = getOrCreateMutableMetadata(target);
  metadata.tableName = options.name ?? metadata.tableName ?? toSnakeCase(target.name);
  metadata.schema = options.schema ?? metadata.schema;
}

export function registerColumn(
  target: object,
  propertyKey: string | symbol,
  options: ColumnOptions = {},
): void {
  const metadata = getOrCreateMutableMetadata(target.constructor as EntityTarget);
  const propertyName = toPropertyName(propertyKey);

  metadata.columns.set(propertyName, createColumnMetadata(
    propertyName,
    options,
    { primary: false, version: false, createdAt: false, updatedAt: false },
  ));

  registerColumnIndexOptions(metadata, propertyName, options);
}

export function registerId(
  target: object,
  propertyKey: string | symbol,
  options: ColumnOptions = {},
): void {
  const metadata = getOrCreateMutableMetadata(target.constructor as EntityTarget);
  const propertyName = toPropertyName(propertyKey);
  const column: ColumnMetadata = {
    ...createColumnMetadata(
      propertyName,
      options,
      { primary: true, version: false, createdAt: false, updatedAt: false },
    ),
    nullable: false,
  };

  metadata.columns.set(propertyName, column);
  metadata.primaryColumn ??= column;
  metadata.primaryColumns.set(propertyName, column);
  registerColumnIndexOptions(metadata, propertyName, options);
}

export function registerVersion(
  target: object,
  propertyKey: string | symbol,
  options: ColumnOptions = {},
): void {
  const metadata = getOrCreateMutableMetadata(target.constructor as EntityTarget);
  const propertyName = toPropertyName(propertyKey);
  const column: ColumnMetadata = {
    ...createColumnMetadata(
      propertyName,
      options,
      { primary: false, version: true, createdAt: false, updatedAt: false },
    ),
    nullable: false,
  };

  metadata.columns.set(propertyName, column);
  metadata.versionColumn = column;
  registerColumnIndexOptions(metadata, propertyName, options);
}

export function registerCreatedAt(
  target: object,
  propertyKey: string | symbol,
  options: ColumnOptions = {},
): void {
  const metadata = getOrCreateMutableMetadata(target.constructor as EntityTarget);
  const propertyName = toPropertyName(propertyKey);
  const column = createColumnMetadata(
    propertyName,
    options,
    { primary: false, version: false, createdAt: true, updatedAt: false },
  );

  metadata.columns.set(propertyName, column);
  metadata.createdAtColumn = column;
  registerColumnIndexOptions(metadata, propertyName, options);
}

export function registerUpdatedAt(
  target: object,
  propertyKey: string | symbol,
  options: ColumnOptions = {},
): void {
  const metadata = getOrCreateMutableMetadata(target.constructor as EntityTarget);
  const propertyName = toPropertyName(propertyKey);
  const column = createColumnMetadata(
    propertyName,
    options,
    { primary: false, version: false, createdAt: false, updatedAt: true },
  );

  metadata.columns.set(propertyName, column);
  metadata.updatedAtColumn = column;
  registerColumnIndexOptions(metadata, propertyName, options);
}

export function registerIndex(
  target: EntityTarget,
  options: IndexOptions,
): void {
  const metadata = getOrCreateMutableMetadata(target);
  const propertyNames = options.columns;

  if (propertyNames.length === 0) {
    throw new Error("Class-level indexes require at least one column.");
  }

  const index: IndexMetadata = {
    name: options.name,
    propertyNames,
    unique: options.unique ?? false,
  };

  metadata.indexes.set(indexKey(index), index);
}

export function registerRelation(
  target: object,
  propertyKey: string | symbol,
  kind: RelationKind,
  relationTarget: () => EntityTarget,
  options: RelationOptions = {},
): void {
  const metadata = getOrCreateMutableMetadata(target.constructor as EntityTarget);
  const propertyName = toPropertyName(propertyKey);

  metadata.relations.set(propertyName, {
    propertyName,
    kind,
    target: relationTarget,
    mappedBy: options.mappedBy,
    inversedBy: options.inversedBy,
    joinColumn: options.joinColumn,
    joinColumns: options.joinColumns,
    joinTable: options.joinTable,
    foreignKeyName: options.foreignKeyName,
    onDelete: options.onDelete,
    onUpdate: options.onUpdate,
    cascade: normalizeCascade(options.cascade),
    orphanRemoval: options.orphanRemoval ?? false,
  });
}

export function getEntityMetadata<TEntity extends object>(
  target: EntityTarget<TEntity>,
): EntityMetadata {
  const metadata = metadataByTarget.get(target);

  if (!metadata?.tableName) {
    throw new Error(`Entity metadata for "${target.name}" was not registered.`);
  }

  return {
    target,
    tableName: metadata.tableName,
    schema: metadata.schema,
    columns: [...metadata.columns.values()],
    indexes: [...metadata.indexes.values()],
    relations: [...metadata.relations.values()],
    primaryColumn: metadata.primaryColumn,
    primaryColumns: [...metadata.primaryColumns.values()],
    versionColumn: metadata.versionColumn,
    createdAtColumn: metadata.createdAtColumn,
    updatedAtColumn: metadata.updatedAtColumn,
  };
}

export function getOptionalEntityMetadata<TEntity extends object>(
  target: EntityTarget<TEntity> | undefined,
): EntityMetadata | undefined {
  return target ? getEntityMetadata(target) : undefined;
}

function createColumnMetadata(
  propertyName: string,
  options: ColumnOptions,
  flags: Pick<ColumnMetadata, "primary" | "version" | "createdAt" | "updatedAt">,
): ColumnMetadata {
  return {
    propertyName,
    columnName: options.name ?? toSnakeCase(propertyName),
    nullable: options.nullable ?? false,
    type: options.type,
    ...(options.default !== undefined ? { default: options.default } : {}),
    ...(options.generationStrategy !== undefined
      ? { generationStrategy: options.generationStrategy }
      : {}),
    ...(options.sequenceName !== undefined
      ? { sequenceName: options.sequenceName }
      : {}),
    ...flags,
  };
}

function registerColumnIndexOptions(
  metadata: MutableEntityMetadata,
  propertyName: string,
  options: ColumnOptions,
): void {
  if (options.index) {
    const index = columnIndex(propertyName, options.index, false);
    metadata.indexes.set(indexKey(index), index);
  }

  if (options.unique) {
    const index = columnIndex(propertyName, options.unique, true);
    metadata.indexes.set(indexKey(index), index);
  }
}

function columnIndex(
  propertyName: string,
  value: boolean | string,
  unique: boolean,
): IndexMetadata {
  return {
    name: typeof value === "string" ? value : undefined,
    propertyNames: [propertyName],
    unique,
  };
}

function indexKey(index: IndexMetadata): string {
  return `${index.unique ? "unique" : "index"}:${index.name ?? index.propertyNames.join(",")}`;
}

function getOrCreateMutableMetadata(
  target: EntityTarget,
): MutableEntityMetadata {
  const current = metadataByTarget.get(target);

  if (current) {
    return current;
  }

  const metadata: MutableEntityMetadata = {
    target,
    tableName: undefined,
    schema: undefined,
    columns: new Map(),
    indexes: new Map(),
    relations: new Map(),
    primaryColumn: undefined,
    primaryColumns: new Map(),
    versionColumn: undefined,
    createdAtColumn: undefined,
    updatedAtColumn: undefined,
  };
  metadataByTarget.set(target, metadata);

  return metadata;
}

function normalizeCascade(
  cascade: RelationOptions["cascade"],
): CascadeType[] {
  if (cascade === true) {
    return [CascadeType.PERSIST, CascadeType.REMOVE];
  }

  if (!cascade) {
    return [];
  }

  const values = Array.isArray(cascade) ? cascade : [cascade];
  return [...new Set(values.map(readCascadeType))];
}

function readCascadeType(value: CascadeType | `${CascadeType}`): CascadeType {
  switch (value) {
    case CascadeType.PERSIST:
      return CascadeType.PERSIST;
    case CascadeType.REMOVE:
      return CascadeType.REMOVE;
    default:
      throw new Error(`Unsupported cascade type "${value}".`);
  }
}

function toPropertyName(propertyKey: string | symbol): string {
  if (typeof propertyKey === "symbol") {
    throw new Error("Symbol properties are not supported as entity fields.");
  }

  return propertyKey;
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match, index) =>
    `${index === 0 ? "" : "_"}${match.toLowerCase()}`,
  );
}
