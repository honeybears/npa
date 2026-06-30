export type EntityTarget<TEntity extends object = object> = new (
  ...args: any[]
) => TEntity;

export interface EntityOptions {
  name?: string;
  schema?: string;
}

export interface ColumnOptions {
  name?: string;
  nullable?: boolean;
  type?: string;
  index?: boolean | string;
  unique?: boolean | string;
}

export interface IndexOptions {
  name?: string;
  columns?: string[];
}

export interface RelationOptions {
  mappedBy?: string;
  inversedBy?: string;
  joinColumn?: string;
  joinTable?: string;
}

export type RelationKind = "one-to-many" | "many-to-one" | "many-to-many";

export interface ColumnMetadata {
  propertyName: string;
  columnName: string;
  nullable: boolean;
  type?: string;
  primary: boolean;
  version: boolean;
}

export interface IndexMetadata {
  name?: string;
  propertyNames: string[];
  unique: boolean;
}

export interface RelationMetadata {
  propertyName: string;
  kind: RelationKind;
  target: () => EntityTarget;
  mappedBy?: string;
  inversedBy?: string;
  joinColumn?: string;
  joinTable?: string;
}

export interface EntityMetadata {
  target: EntityTarget;
  tableName: string;
  schema?: string;
  columns: ColumnMetadata[];
  indexes: IndexMetadata[];
  relations: RelationMetadata[];
  primaryColumn?: ColumnMetadata;
  versionColumn?: ColumnMetadata;
}
