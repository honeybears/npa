export type NPAMigrationAdapterName = "postgresql" | "mysql";

export interface NPAMigrationColumnSchema {
  propertyName: string;
  columnName: string;
  tsType: string;
  dbType?: string;
  defaultValue?: string | number | boolean | null;
  nullable: boolean;
  primary: boolean;
  version: boolean;
}

export interface NPAMigrationIndexSchema {
  name?: string;
  columns: string[];
  unique: boolean;
}

export enum NPAMigrationRelationKind {
  ONE_TO_MANY = "ONE_TO_MANY",
  MANY_TO_ONE = "MANY_TO_ONE",
  MANY_TO_MANY = "MANY_TO_MANY",
}

export enum NPAMigrationReferentialAction {
  CASCADE = "CASCADE",
  SET_NULL = "SET NULL",
  RESTRICT = "RESTRICT",
  NO_ACTION = "NO ACTION",
}

export interface NPAMigrationRelationSchema {
  propertyName: string;
  kind: NPAMigrationRelationKind;
  targetClassName: string;
  mappedBy?: string;
  joinColumn?: string;
  joinTable?: string;
  foreignKeyName?: string;
  onDelete?: NPAMigrationReferentialAction;
  onUpdate?: NPAMigrationReferentialAction;
}

export interface NPAMigrationEntitySchema {
  className: string;
  filePath: string;
  tableName: string;
  schema?: string;
  columns: NPAMigrationColumnSchema[];
  indexes: NPAMigrationIndexSchema[];
  relations: NPAMigrationRelationSchema[];
}

export interface NPAMigrationConfigFile {
  adapter?: NPAMigrationAdapterName;
  url?: string;
  entities?: string | string[];
  migrations?: {
    dir?: string;
    table?: string;
  };
}

export interface ResolvedNPAMigrationConfig {
  adapter: NPAMigrationAdapterName;
  url?: string;
  entities: string[];
  migrations: {
    dir: string;
    table: string;
  };
}

export interface LoadNPAMigrationConfigOptions {
  cwd: string;
  config?: string;
  adapter?: string;
  url?: string;
  entities?: string[];
}

export interface NPAMigrationRunOptions {
  adapter: NPAMigrationAdapterName;
  url?: string;
  entities: NPAMigrationEntitySchema[];
  checksum: string;
  historyTable: string;
  dryRun?: boolean;
}

export interface NPAMigrationResult {
  status: "applied" | "noop" | "dry-run";
  checksum: string;
  statements: string[];
  statementCount: number;
  previousChecksum?: string;
}

export interface NPAMigrationAdapterRunner {
  (options: NPAMigrationRunOptions): Promise<NPAMigrationResult>;
}

export interface NPAMigrationFile {
  name: string;
  checksum: string;
  statements: string[];
  statementCount: number;
  filePath?: string;
}

export interface NPAMigrationDeployOptions {
  adapter: NPAMigrationAdapterName;
  url?: string;
  historyTable: string;
  migrations: NPAMigrationFile[];
  dryRun?: boolean;
}

export interface NPAMigrationDeployItemResult {
  name: string;
  checksum: string;
  statementCount: number;
  status: "applied" | "pending" | "skipped";
}

export interface NPAMigrationDeployResult {
  status: "applied" | "noop" | "dry-run";
  migrations: NPAMigrationDeployItemResult[];
  statementCount: number;
}

export interface NPAMigrationAdapter {
  plan(options: NPAMigrationRunOptions): Promise<NPAMigrationResult>;
  push(options: NPAMigrationRunOptions): Promise<NPAMigrationResult>;
  deploy(options: NPAMigrationDeployOptions): Promise<NPAMigrationDeployResult>;
}
