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
  default?: string | number | boolean | null;
  index?: boolean | string;
  unique?: boolean | string;
}

export interface IndexOptions {
  name?: string;
  columns: string[];
  unique?: boolean;
}

export interface RelationOptions {
  mappedBy?: string;
  inversedBy?: string;
  joinColumn?: string;
  joinTable?: string;
  foreignKeyName?: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export enum RelationKind {
  ONE_TO_MANY = "ONE_TO_MANY",
  MANY_TO_ONE = "MANY_TO_ONE",
  MANY_TO_MANY = "MANY_TO_MANY",
}

export enum ReferentialAction {
  CASCADE = "CASCADE",
  SET_NULL = "SET NULL",
  RESTRICT = "RESTRICT",
  NO_ACTION = "NO ACTION",
}

export interface ColumnMetadata {
  propertyName: string;
  columnName: string;
  nullable: boolean;
  type?: string;
  default?: string | number | boolean | null;
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
  foreignKeyName?: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
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
