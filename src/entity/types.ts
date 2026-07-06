export type EntityTarget<TEntity extends object = object> = new (
  ...args: any[]
) => TEntity;

export type Relation<TValue> = TValue | Promise<TValue>;

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
  generationStrategy?: GenerationStrategy | `${GenerationStrategy}`;
  sequenceName?: string;
}

export enum GenerationStrategy {
  AUTO_INCREMENT = "AUTO_INCREMENT",
  SEQUENCE = "SEQUENCE",
  UUID = "UUID",
  NONE = "NONE",
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
  joinColumns?: string[];
  joinTable?: string;
  nullable?: boolean;
  fetch?: FetchType | `${FetchType}`;
  foreignKeyName?: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  cascade?: boolean | CascadeType | `${CascadeType}` | Array<CascadeType | `${CascadeType}`>;
  orphanRemoval?: boolean;
}

export enum RelationKind {
  ONE_TO_ONE = "ONE_TO_ONE",
  ONE_TO_MANY = "ONE_TO_MANY",
  MANY_TO_ONE = "MANY_TO_ONE",
  MANY_TO_MANY = "MANY_TO_MANY",
}

export enum CascadeType {
  PERSIST = "PERSIST",
  REMOVE = "REMOVE",
}

export enum FetchType {
  LAZY = "LAZY",
  EAGER = "EAGER",
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
  generationStrategy?: GenerationStrategy | `${GenerationStrategy}`;
  sequenceName?: string;
  primary: boolean;
  version: boolean;
  createdAt: boolean;
  updatedAt: boolean;
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
  joinColumns?: string[];
  joinTable?: string;
  nullable: boolean;
  fetch: FetchType;
  foreignKeyName?: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  cascade: CascadeType[];
  orphanRemoval: boolean;
}

export interface EntityMetadata {
  target: EntityTarget;
  tableName: string;
  schema?: string;
  columns: ColumnMetadata[];
  indexes: IndexMetadata[];
  relations: RelationMetadata[];
  primaryColumn?: ColumnMetadata;
  primaryColumns: ColumnMetadata[];
  versionColumn?: ColumnMetadata;
  createdAtColumn?: ColumnMetadata;
  updatedAtColumn?: ColumnMetadata;
}
