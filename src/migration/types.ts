export type NPAMigrationAdapterName = "postgresql" | "mysql";

export interface NPAMigrationColumnSchema {
  propertyName: string;
  columnName: string;
  tsType: string;
  dbType?: string;
  nullable: boolean;
  primary: boolean;
  version: boolean;
}

export interface NPAMigrationIndexSchema {
  name?: string;
  columns: string[];
  unique: boolean;
}

export type NPAMigrationRelationKind = "many-to-many";

export interface NPAMigrationRelationSchema {
  propertyName: string;
  kind: NPAMigrationRelationKind;
  targetClassName: string;
  joinTable?: string;
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
    table?: string;
  };
}

export interface ResolvedNPAMigrationConfig {
  adapter: NPAMigrationAdapterName;
  url?: string;
  entities: string[];
  migrations: {
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
