export type MigrationAdapterName = "postgresql" | "mysql";
export type MigrationGenerationStrategy =
  | "AUTO_INCREMENT"
  | "SEQUENCE"
  | "UUID"
  | "NONE";

export interface MigrationColumnSchema {
  propertyName: string;
  columnName: string;
  tsType: string;
  dbType?: string;
  defaultValue?: string | number | boolean | null;
  defaultCurrentTimestamp?: boolean;
  generationStrategy?: MigrationGenerationStrategy;
  sequenceName?: string;
  nullable: boolean;
  primary: boolean;
  version: boolean;
  createdAt?: boolean;
  updatedAt?: boolean;
}

export interface MigrationIndexSchema {
  name?: string;
  columns: string[];
  unique: boolean;
}

export enum MigrationRelationKind {
  ONE_TO_ONE = "ONE_TO_ONE",
  ONE_TO_MANY = "ONE_TO_MANY",
  MANY_TO_ONE = "MANY_TO_ONE",
  MANY_TO_MANY = "MANY_TO_MANY",
}

export enum MigrationReferentialAction {
  CASCADE = "CASCADE",
  SET_NULL = "SET NULL",
  RESTRICT = "RESTRICT",
  NO_ACTION = "NO ACTION",
}

export interface MigrationRelationSchema {
  propertyName: string;
  kind: MigrationRelationKind;
  targetClassName: string;
  mappedBy?: string;
  joinColumn?: string;
  joinColumns?: string[];
  joinTable?: string;
  foreignKeyName?: string;
  onDelete?: MigrationReferentialAction;
  onUpdate?: MigrationReferentialAction;
}

export interface MigrationEntitySchema {
  className: string;
  filePath: string;
  tableName: string;
  schema?: string;
  columns: MigrationColumnSchema[];
  indexes: MigrationIndexSchema[];
  relations: MigrationRelationSchema[];
}

export interface MigrationTableReference {
  schema?: string;
  tableName: string;
}

export interface MigrationTableRename {
  kind: "table";
  from: MigrationTableReference;
  to: MigrationTableReference;
}

export interface MigrationColumnRename {
  kind: "column";
  table: MigrationTableReference;
  from: string;
  to: string;
}

export type MigrationRename = MigrationTableRename | MigrationColumnRename;

export interface MigrationConfigFile {
  adapter?: MigrationAdapterName;
  url?: string;
  entities?: string | string[];
  migrations?: {
    dir?: string;
    table?: string;
  };
}

export interface ResolvedMigrationConfig {
  adapter: MigrationAdapterName;
  url?: string;
  entities: string[];
  migrations: {
    dir: string;
    table: string;
  };
}

export interface LoadMigrationConfigOptions {
  cwd: string;
  config?: string;
  adapter?: string;
  url?: string;
  entities?: string[];
}

export interface MigrationRunOptions {
  adapter: MigrationAdapterName;
  url?: string;
  entities: MigrationEntitySchema[];
  checksum: string;
  historyTable: string;
  dryRun?: boolean;
  allowDestructive?: boolean;
  renames?: MigrationRename[];
}

export interface MigrationResult {
  status: "applied" | "noop" | "dry-run";
  checksum: string;
  statements: string[];
  statementCount: number;
  downStatements?: string[];
  downStatementCount?: number;
  previousChecksum?: string;
}

export interface MigrationAdapterRunner {
  (options: MigrationRunOptions): Promise<MigrationResult>;
}

export interface MigrationFile {
  name: string;
  checksum: string;
  statements: string[];
  statementCount: number;
  downStatements: string[];
  downStatementCount: number;
  filePath?: string;
  downFilePath?: string;
}

export interface MigrationDeployOptions {
  adapter: MigrationAdapterName;
  url?: string;
  historyTable: string;
  migrations: MigrationFile[];
  dryRun?: boolean;
  allowDestructive?: boolean;
  allowDrift?: boolean;
}

export interface MigrationDeployItemResult {
  name: string;
  checksum: string;
  statementCount: number;
  status: "applied" | "pending" | "skipped";
}

export interface MigrationDeployResult {
  status: "applied" | "noop" | "dry-run";
  migrations: MigrationDeployItemResult[];
  statementCount: number;
}

export interface MigrationAdapter {
  plan(options: MigrationRunOptions): Promise<MigrationResult>;
  push(options: MigrationRunOptions): Promise<MigrationResult>;
  deploy(options: MigrationDeployOptions): Promise<MigrationDeployResult>;
}
