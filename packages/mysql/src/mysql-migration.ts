import type {
  NPAMigrationColumnSchema,
  NPAMigrationDeployOptions,
  NPAMigrationDeployResult,
  NPAMigrationEntitySchema,
  NPAMigrationFile,
  NPAMigrationIndexSchema,
  NPAMigrationResult,
  NPAMigrationRunOptions,
} from "@honeybeaers/npa";
import { NPAMigrationRelationKind } from "@honeybeaers/npa";
import { createHash } from "node:crypto";
import { MysqlConnection, MysqlDriverConnection } from "./mysql-connection";
import { normalizeMysqlResult } from "./mysql-result";

const MIGRATION_NAME = "schema";
const LOCK_KEY = "npa:migrations";
const MAX_FOREIGN_KEY_IDENTIFIER_LENGTH = 64;

interface MigrationTableSchema {
  tableName: string;
  schema?: string;
  columns: NPAMigrationColumnSchema[];
  indexes: NPAMigrationIndexSchema[];
  foreignKeys: MigrationForeignKeySchema[];
  primaryKey?: string[];
}

interface MigrationForeignKeySchema {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedSchema?: string;
  referencedColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

interface CurrentColumnSchema {
  columnName: string;
  type: string;
  nullable: boolean;
}

interface CurrentIndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

interface CurrentForeignKeySchema {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedSchema?: string;
  referencedColumns: string[];
}

interface CurrentTableSchema {
  exists: boolean;
  columns: Map<string, CurrentColumnSchema>;
  indexes: Map<string, CurrentIndexSchema>;
  foreignKeys: Map<string, CurrentForeignKeySchema>;
}

interface MysqlColumnRow {
  columnName: string;
  columnType: string;
  isNullable: "YES" | "NO";
}

interface MysqlIndexRow {
  indexName: string;
  nonUnique: number;
  columnName: string;
  sequence: number;
}

interface MysqlForeignKeyRow {
  constraintName: string;
  columnName: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
  position: number;
}

interface MysqlHistoryRow {
  checksum: string;
}

export interface MysqlMigrationCompileOptions {
  entities: NPAMigrationEntitySchema[];
  historyTable?: string;
  checksum?: string;
}

export function compileMysqlMigrationStatements(
  options: MysqlMigrationCompileOptions,
): string[] {
  return [
    compileMysqlHistoryTable(options.historyTable ?? "_npa_migrations"),
    ...compileMysqlSchemaStatements(options.entities),
  ];
}

export function compileMysqlSchemaStatements(
  entities: NPAMigrationEntitySchema[],
): string[] {
  const desiredTables = buildDesiredTables(entities);

  return [
    ...compileMysqlNamespaceStatements(entities),
    ...desiredTables.flatMap((table) => compileMysqlCreateTableStatements(table)),
    ...desiredTables.flatMap((table) => compileMysqlForeignKeyDiffStatements(table, new Map())),
  ];
}

export function compileMysqlHistoryTable(historyTable: string): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${quoteQualifiedIdentifier(historyTable)} (`,
    "  name VARCHAR(255) PRIMARY KEY,",
    "  checksum VARCHAR(64) NOT NULL,",
    "  adapter VARCHAR(32) NOT NULL,",
    "  applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),",
    "  statement_count INT NOT NULL",
    ")",
  ].join("\n");
}

export async function planMysqlMigration(
  options: NPAMigrationRunOptions,
): Promise<NPAMigrationResult> {
  if (!options.url) {
    const statements = compileMysqlSchemaStatements(options.entities);

    return {
      status: "dry-run",
      checksum: options.checksum,
      statements,
      statementCount: statements.length,
    };
  }

  const connection = new MysqlConnection(await createPool(options.url));

  try {
    const namespaceStatements = compileMysqlNamespaceStatements(options.entities);
    const desiredTables = buildDesiredTables(options.entities);
    const currentTables = await readCurrentTables(connection, desiredTables);
    const statements = [
      ...namespaceStatements,
      ...compileMysqlTableDiffStatements(desiredTables, currentTables),
    ];

    return {
      status: "dry-run",
      checksum: options.checksum,
      statements,
      statementCount: statements.length,
    };
  } finally {
    await connection.close();
  }
}

export async function migrateMysql(
  options: NPAMigrationRunOptions,
): Promise<NPAMigrationResult> {
  if (options.dryRun && !options.url) {
    const plan = await planMysqlMigration(options);
    const statements = [
      compileMysqlHistoryTable(options.historyTable),
      ...plan.statements,
      compileHistoryUpsertPreview(options.historyTable, options.checksum, plan.statementCount),
    ];

    return {
      status: "dry-run",
      checksum: options.checksum,
      statements,
      statementCount: statements.length,
    };
  }

  if (!options.url) {
    throw new Error("MySQL migration requires a database url.");
  }

  const connection = new MysqlConnection(await createPool(options.url));

  try {
    if (options.dryRun) {
      const plan = await planMysqlMigration(options);
      const statements = [
        compileMysqlHistoryTable(options.historyTable),
        ...plan.statements,
        compileHistoryUpsertPreview(options.historyTable, options.checksum, plan.statementCount),
      ];

      return {
        status: "dry-run",
        checksum: options.checksum,
        statements,
        statementCount: statements.length,
      };
    }

    await acquireLock(connection);
    await connection.query(compileMysqlHistoryTable(options.historyTable));
    const previousChecksum = await readPreviousChecksum(connection, options.historyTable);

    if (previousChecksum === options.checksum) {
      return {
        status: "noop",
        checksum: options.checksum,
        previousChecksum,
        statements: [],
        statementCount: 0,
      };
    }

    const namespaceStatements = compileMysqlNamespaceStatements(options.entities);

    for (const statement of namespaceStatements) {
      await connection.query(statement);
    }

    const desiredTables = buildDesiredTables(options.entities);
    const currentTables = await readCurrentTables(connection, desiredTables);
    const tableStatements = compileMysqlTableDiffStatements(desiredTables, currentTables);
    const migrationStatements = [...namespaceStatements, ...tableStatements];

    for (const statement of tableStatements) {
      await connection.query(statement);
    }

    await upsertHistory(connection, options, migrationStatements.length);

    return {
      status: "applied",
      checksum: options.checksum,
      previousChecksum,
      statements: migrationStatements,
      statementCount: migrationStatements.length,
    };
  } finally {
    await Promise.resolve(connection.query("SELECT RELEASE_LOCK(?)", [LOCK_KEY])).catch(
      () => undefined,
    );
    await connection.close();
  }
}

export async function deployMysqlMigrations(
  options: NPAMigrationDeployOptions,
): Promise<NPAMigrationDeployResult> {
  if (!options.url) {
    throw new Error("MySQL migration deploy requires a database url.");
  }

  const connection = new MysqlConnection(await createPool(options.url));

  try {
    await acquireLock(connection);
    await connection.query(compileMysqlHistoryTable(options.historyTable));
    const results: NPAMigrationDeployResult["migrations"] = [];
    let statementCount = 0;
    let pendingCount = 0;

    for (const migration of options.migrations) {
      const existing = await readHistoryRecord(
        connection,
        options.historyTable,
        migration.name,
      );

      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} checksum mismatch. The migration file changed after it was applied.`,
          );
        }

        results.push(toDeployResult(migration, "skipped"));
        continue;
      }

      const status = options.dryRun ? "pending" : "applied";
      results.push(toDeployResult(migration, status));
      pendingCount += 1;
      statementCount += migration.statementCount;

      if (options.dryRun) {
        continue;
      }

      for (const statement of migration.statements) {
        await connection.query(statement);
      }

      await insertHistory(connection, options, migration);
    }

    return {
      status: options.dryRun
        ? "dry-run"
        : pendingCount === 0
          ? "noop"
          : "applied",
      migrations: results,
      statementCount,
    };
  } finally {
    await Promise.resolve(connection.query("SELECT RELEASE_LOCK(?)", [LOCK_KEY])).catch(
      () => undefined,
    );
    await connection.close();
  }
}

function compileMysqlNamespaceStatements(entities: NPAMigrationEntitySchema[]): string[] {
  const schemas = new Set(
    buildDesiredTables(entities)
      .map((table) => table.schema)
      .filter((schema): schema is string => !!schema),
  );

  return [...schemas]
    .sort()
    .map((schema) => `CREATE DATABASE IF NOT EXISTS ${quoteQualifiedIdentifier(schema)}`);
}

function compileMysqlTableDiffStatements(
  desiredTables: MigrationTableSchema[],
  currentTables: Map<string, CurrentTableSchema>,
): string[] {
  const statements: string[] = [];
  const foreignKeyStatements: string[] = [];

  for (const table of desiredTables) {
    const currentTable = currentTables.get(tableKey(table));

    if (!currentTable?.exists) {
      statements.push(...compileMysqlCreateTableStatements(table));
      foreignKeyStatements.push(
        ...compileMysqlForeignKeyDiffStatements(table, new Map()),
      );
      continue;
    }

    for (const column of table.columns) {
      const currentColumn = currentTable.columns.get(column.columnName);

      if (!currentColumn) {
        statements.push(
          `ALTER TABLE ${qualifiedTable(table)} ADD COLUMN ${quoteQualifiedIdentifier(column.columnName)} ${columnDefinition(column, { inlinePrimary: column.primary })}`,
        );
        continue;
      }

      const expectedType = normalizeMysqlTypeName(columnAlterType(column));
      const currentType = normalizeMysqlTypeName(currentColumn.type);
      const expectedNullable = column.primary ? false : column.nullable;

      if (!column.primary && (currentType !== expectedType || currentColumn.nullable !== expectedNullable)) {
        statements.push(
          `ALTER TABLE ${qualifiedTable(table)} MODIFY COLUMN ${quoteQualifiedIdentifier(column.columnName)} ${columnAlterType(column)}${expectedNullable ? "" : " NOT NULL"}`,
        );
      }
    }

    const desiredColumnNames = new Set(table.columns.map((column) => column.columnName));

    for (const column of [...currentTable.columns.values()].sort(compareCurrentColumns)) {
      if (!desiredColumnNames.has(column.columnName)) {
        statements.push(
          `ALTER TABLE ${qualifiedTable(table)} DROP COLUMN ${quoteQualifiedIdentifier(column.columnName)}`,
        );
      }
    }

    statements.push(...compileMysqlIndexDiffStatements(table, currentTable.indexes));
    foreignKeyStatements.push(
      ...compileMysqlForeignKeyDiffStatements(table, currentTable.foreignKeys),
    );
  }

  return [...statements, ...foreignKeyStatements];
}

function compileMysqlCreateTableStatements(table: MigrationTableSchema): string[] {
  return [
    compileMysqlCreateTable(table),
    ...table.indexes.map((index) => compileMysqlCreateIndex(table, index)),
  ];
}

function compileMysqlForeignKeyDiffStatements(
  table: MigrationTableSchema,
  currentForeignKeys: Map<string, CurrentForeignKeySchema>,
): string[] {
  const statements: string[] = [];

  for (const foreignKey of [...table.foreignKeys].sort(compareForeignKeys)) {
    if (currentForeignKeys.has(foreignKey.name)) {
      continue;
    }

    statements.push(
      `ALTER TABLE ${qualifiedTable(table)} ADD ${compileMysqlForeignKeyConstraint(foreignKey)}`,
    );
  }

  return statements;
}

function compileMysqlIndexDiffStatements(
  table: MigrationTableSchema,
  currentIndexes: Map<string, CurrentIndexSchema>,
): string[] {
  const statements: string[] = [];

  const desiredIndexNames = new Set(
    table.indexes.map((index) => resolveIndexName(table, index)),
  );

  for (const index of [...table.indexes].sort(compareIndexes)) {
    const indexName = resolveIndexName(table, index);
    const currentIndex = currentIndexes.get(indexName);

    if (!currentIndex) {
      statements.push(compileMysqlCreateIndex(table, index));
      continue;
    }

    if (
      currentIndex.primary ||
      currentIndex.unique !== index.unique ||
      currentIndex.columns.join(",") !== index.columns.join(",")
    ) {
      statements.push(`ALTER TABLE ${qualifiedTable(table)} DROP INDEX ${quoteQualifiedIdentifier(indexName)}`);
      statements.push(compileMysqlCreateIndex(table, index));
    }
  }

  for (const currentIndex of [...currentIndexes.values()].sort(compareCurrentIndexes)) {
    if (!currentIndex.primary && !desiredIndexNames.has(currentIndex.name)) {
      statements.push(`ALTER TABLE ${qualifiedTable(table)} DROP INDEX ${quoteQualifiedIdentifier(currentIndex.name)}`);
    }
  }

  return statements;
}

function compileMysqlCreateTable(table: MigrationTableSchema): string {
  const columnLines = table.columns.map(
    (column) => `  ${quoteQualifiedIdentifier(column.columnName)} ${columnDefinition(column, { inlinePrimary: !table.primaryKey })}`,
  );
  const primaryKeyLines = table.primaryKey?.length
    ? [`  PRIMARY KEY (${table.primaryKey.map(quoteQualifiedIdentifier).join(", ")})`]
    : [];

  return [
    `CREATE TABLE IF NOT EXISTS ${qualifiedTable(table)} (`,
    [...columnLines, ...primaryKeyLines].join(",\n"),
    ")",
  ].join("\n");
}

function compileMysqlForeignKeyConstraint(
  foreignKey: MigrationForeignKeySchema,
): string {
  return [
    `CONSTRAINT ${quoteQualifiedIdentifier(foreignKey.name)}`,
    `FOREIGN KEY (${foreignKey.columns.map(quoteQualifiedIdentifier).join(", ")})`,
    `REFERENCES ${qualifiedTable({ schema: foreignKey.referencedSchema, tableName: foreignKey.referencedTable })} (${foreignKey.referencedColumns.map(quoteQualifiedIdentifier).join(", ")})`,
    foreignKey.onDelete ? `ON DELETE ${foreignKey.onDelete}` : undefined,
    foreignKey.onUpdate ? `ON UPDATE ${foreignKey.onUpdate}` : undefined,
  ].filter(Boolean).join(" ");
}

function columnDefinition(
  column: NPAMigrationColumnSchema,
  options: { inlinePrimary: boolean },
): string {
  const dbType = column.dbType ?? defaultType(column, { identity: options.inlinePrimary });
  const constraints = options.inlinePrimary && column.primary
    ? " PRIMARY KEY"
    : column.nullable
      ? ""
      : " NOT NULL";

  return `${dbType}${constraints}`;
}

function columnAlterType(column: NPAMigrationColumnSchema): string {
  return column.dbType ?? defaultType(column, { identity: false });
}

function defaultType(
  column: NPAMigrationColumnSchema,
  options: { identity: boolean },
): string {
  const normalized = normalizeType(column.tsType);

  if (column.primary && normalized === "number" && options.identity) {
    return "INT AUTO_INCREMENT";
  }

  if (normalized === "string") {
    return "VARCHAR(255)";
  }

  if (normalized === "number") {
    return "INT";
  }

  if (normalized === "boolean") {
    return "BOOLEAN";
  }

  if (normalized === "Date") {
    return "DATETIME(3)";
  }

  throw new Error(
    `Unsupported MySQL migration type "${column.tsType}" for ${column.propertyName}. Use @Column({ type: "..." }).`,
  );
}

function buildDesiredTables(entities: NPAMigrationEntitySchema[]): MigrationTableSchema[] {
  const tables = new Map<string, MigrationTableSchema>();
  const sortedEntities = [...entities].sort(compareEntities);
  const byClassName = new Map(sortedEntities.map((entity) => [entity.className, entity]));

  for (const entity of sortedEntities) {
    const table = entityTable(entity, byClassName);
    tables.set(tableKey(table), table);
  }

  for (const table of buildJoinTables(sortedEntities)) {
    tables.set(tableKey(table), table);
  }

  return [...tables.values()].sort(compareTables);
}

function entityTable(
  entity: NPAMigrationEntitySchema,
  byClassName: Map<string, NPAMigrationEntitySchema>,
): MigrationTableSchema {
  const columns = new Map(entity.columns.map((column) => [column.columnName, column]));
  const foreignKeys: MigrationForeignKeySchema[] = [];

  for (const relation of entity.relations ?? []) {
    if (relation.kind !== NPAMigrationRelationKind.MANY_TO_ONE) {
      continue;
    }

    const target = byClassName.get(relation.targetClassName);

    if (!target) {
      throw new Error(
        `@ManyToOne for ${entity.className}.${relation.propertyName} targets unknown entity ${relation.targetClassName}.`,
      );
    }

    const targetPrimary = primaryColumn(target);
    const joinColumn = relation.joinColumn ?? `${relation.propertyName}_${targetPrimary.columnName}`;
    const column = {
      ...relationColumn(targetPrimary, joinColumn),
      nullable: true,
    };

    columns.set(joinColumn, column);
    foreignKeys.push({
      name: relation.foreignKeyName ?? foreignKeyName(entity.tableName, [joinColumn], target.tableName),
      columns: [joinColumn],
      referencedSchema: target.schema,
      referencedTable: target.tableName,
      referencedColumns: [targetPrimary.columnName],
      onDelete: relation.onDelete,
      onUpdate: relation.onUpdate,
    });
  }

  return {
    tableName: entity.tableName,
    schema: entity.schema,
    columns: [...columns.values()],
    indexes: entity.indexes ?? [],
    foreignKeys,
  };
}

function buildJoinTables(entities: NPAMigrationEntitySchema[]): MigrationTableSchema[] {
  const byClassName = new Map(entities.map((entity) => [entity.className, entity]));
  const tables: MigrationTableSchema[] = [];

  for (const entity of entities) {
    for (const relation of entity.relations ?? []) {
      if (relation.kind !== NPAMigrationRelationKind.MANY_TO_MANY) {
        continue;
      }

      const target = byClassName.get(relation.targetClassName);

      if (!target) {
        throw new Error(
          `@ManyToMany for ${entity.className}.${relation.propertyName} targets unknown entity ${relation.targetClassName}.`,
        );
      }

      const sourcePrimary = primaryColumn(entity);
      const targetPrimary = primaryColumn(target);
      const joinTable = resolveJoinTable(entity, target, relation.joinTable);
      let sourceColumnName = joinColumnName(entity, sourcePrimary);
      let targetColumnName = joinColumnName(target, targetPrimary);

      if (sourceColumnName === targetColumnName) {
        sourceColumnName = `${toSnakeCase(entity.className)}_${sourcePrimary.columnName}`;
        targetColumnName = `${toSnakeCase(target.className)}_${targetPrimary.columnName}`;
      }

      tables.push({
        ...joinTable,
        columns: [
          relationColumn(sourcePrimary, sourceColumnName),
          relationColumn(targetPrimary, targetColumnName),
        ],
        indexes: [],
        foreignKeys: [
          {
            name: foreignKeyName(joinTable.tableName, [sourceColumnName], entity.tableName),
            columns: [sourceColumnName],
            referencedSchema: entity.schema,
            referencedTable: entity.tableName,
            referencedColumns: [sourcePrimary.columnName],
          },
          {
            name: foreignKeyName(joinTable.tableName, [targetColumnName], target.tableName),
            columns: [targetColumnName],
            referencedSchema: target.schema,
            referencedTable: target.tableName,
            referencedColumns: [targetPrimary.columnName],
          },
        ],
        primaryKey: [sourceColumnName, targetColumnName],
      });
    }
  }

  return tables;
}

function relationColumn(
  source: NPAMigrationColumnSchema,
  columnName: string,
): NPAMigrationColumnSchema {
  return {
    ...source,
    propertyName: columnName,
    columnName,
    dbType: source.dbType ?? defaultType(source, { identity: false }),
    nullable: false,
    primary: false,
    version: false,
  };
}

function resolveJoinTable(
  source: NPAMigrationEntitySchema,
  target: NPAMigrationEntitySchema,
  joinTable?: string,
): Pick<MigrationTableSchema, "schema" | "tableName"> {
  const fallbackTableName = `${source.tableName}_${target.tableName}`;
  const rawTableName = joinTable ?? fallbackTableName;
  const separatorIndex = rawTableName.indexOf(".");

  if (separatorIndex > 0) {
    return {
      schema: rawTableName.slice(0, separatorIndex),
      tableName: rawTableName.slice(separatorIndex + 1),
    };
  }

  return {
    schema: source.schema ?? target.schema,
    tableName: rawTableName,
  };
}

function joinColumnName(
  entity: NPAMigrationEntitySchema,
  primary: NPAMigrationColumnSchema,
): string {
  const prefix = `${toSnakeCase(entity.className)}_`;

  return primary.columnName.startsWith(prefix)
    ? primary.columnName
    : `${prefix}${primary.columnName}`;
}

function primaryColumn(entity: NPAMigrationEntitySchema): NPAMigrationColumnSchema {
  const primary = entity.columns.find((column) => column.primary);

  if (!primary) {
    throw new Error(`${entity.className} must declare an @Id column before it can be migrated.`);
  }

  return primary;
}

async function readCurrentTables(
  connection: MysqlConnection,
  desiredTables: MigrationTableSchema[],
): Promise<Map<string, CurrentTableSchema>> {
  const currentTables = new Map<string, CurrentTableSchema>();

  for (const table of desiredTables) {
    const result = normalizeMysqlResult<MysqlColumnRow>(
      await connection.query(
        [
          "SELECT",
          "  COLUMN_NAME AS columnName,",
          "  COLUMN_TYPE AS columnType,",
          "  IS_NULLABLE AS isNullable",
          "FROM information_schema.columns",
          `WHERE table_schema = ${table.schema ? "?" : "DATABASE()"} AND table_name = ?`,
          "ORDER BY ORDINAL_POSITION",
        ].join("\n"),
        table.schema ? [table.schema, table.tableName] : [table.tableName],
      ),
    );
    const columns = new Map<string, CurrentColumnSchema>();

    for (const row of result.rows) {
      columns.set(row.columnName, {
        columnName: row.columnName,
        type: row.columnType,
        nullable: row.isNullable === "YES",
      });
    }

    const indexes = await readCurrentIndexes(connection, table);
    const foreignKeys = await readCurrentForeignKeys(connection, table);

    currentTables.set(tableKey(table), {
      exists: columns.size > 0,
      columns,
      indexes,
      foreignKeys,
    });
  }

  return currentTables;
}

async function readCurrentIndexes(
  connection: MysqlConnection,
  table: MigrationTableSchema,
): Promise<Map<string, CurrentIndexSchema>> {
  const result = normalizeMysqlResult<MysqlIndexRow>(
    await connection.query(
      [
        "SELECT",
        "  INDEX_NAME AS indexName,",
        "  NON_UNIQUE AS nonUnique,",
        "  COLUMN_NAME AS columnName,",
        "  SEQ_IN_INDEX AS sequence",
        "FROM information_schema.statistics",
        `WHERE table_schema = ${table.schema ? "?" : "DATABASE()"} AND table_name = ?`,
        "ORDER BY INDEX_NAME, SEQ_IN_INDEX",
      ].join("\n"),
      table.schema ? [table.schema, table.tableName] : [table.tableName],
    ),
  );
  const indexes = new Map<string, CurrentIndexSchema>();

  for (const row of result.rows) {
    const current = indexes.get(row.indexName) ?? {
      name: row.indexName,
      columns: [],
      unique: row.nonUnique === 0,
      primary: row.indexName === "PRIMARY",
    };

    current.columns[row.sequence - 1] = row.columnName;
    indexes.set(row.indexName, current);
  }

  for (const index of indexes.values()) {
    index.columns = index.columns.filter(Boolean);
  }

  return indexes;
}

async function readCurrentForeignKeys(
  connection: MysqlConnection,
  table: MigrationTableSchema,
): Promise<Map<string, CurrentForeignKeySchema>> {
  const result = normalizeMysqlResult<MysqlForeignKeyRow>(
    await connection.query(
      [
        "SELECT",
        "  CONSTRAINT_NAME AS constraintName,",
        "  COLUMN_NAME AS columnName,",
        "  REFERENCED_TABLE_SCHEMA AS referencedSchema,",
        "  REFERENCED_TABLE_NAME AS referencedTable,",
        "  REFERENCED_COLUMN_NAME AS referencedColumn,",
        "  ORDINAL_POSITION AS position",
        "FROM information_schema.KEY_COLUMN_USAGE",
        `WHERE table_schema = ${table.schema ? "?" : "DATABASE()"} AND table_name = ?`,
        "  AND REFERENCED_TABLE_NAME IS NOT NULL",
        "ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
      ].join("\n"),
      table.schema ? [table.schema, table.tableName] : [table.tableName],
    ),
  );
  const foreignKeys = new Map<string, CurrentForeignKeySchema>();

  for (const row of result.rows) {
    const current = foreignKeys.get(row.constraintName) ?? {
      name: row.constraintName,
      columns: [],
      referencedSchema: row.referencedSchema,
      referencedTable: row.referencedTable,
      referencedColumns: [],
    };

    current.columns[row.position - 1] = row.columnName;
    current.referencedColumns[row.position - 1] = row.referencedColumn;
    foreignKeys.set(row.constraintName, current);
  }

  for (const foreignKey of foreignKeys.values()) {
    foreignKey.columns = foreignKey.columns.filter(Boolean);
    foreignKey.referencedColumns = foreignKey.referencedColumns.filter(Boolean);
  }

  return foreignKeys;
}

async function acquireLock(connection: MysqlConnection): Promise<void> {
  const result = normalizeMysqlResult<{ acquired: number }>(
    await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [LOCK_KEY]),
  );
  const acquired = result.rows[0]?.acquired;

  if (acquired !== 1) {
    throw new Error("Could not acquire NPA MySQL migration lock.");
  }
}

async function readPreviousChecksum(
  connection: MysqlConnection,
  historyTable: string,
): Promise<string | undefined> {
  const result = await readHistoryRecord(connection, historyTable, MIGRATION_NAME);

  return result?.checksum;
}

async function readHistoryRecord(
  connection: MysqlConnection,
  historyTable: string,
  name: string,
): Promise<MysqlHistoryRow | undefined> {
  const result = normalizeMysqlResult<MysqlHistoryRow>(
    await connection.query(
      `SELECT checksum FROM ${quoteQualifiedIdentifier(historyTable)} WHERE name = ? LIMIT 1`,
      [name],
    ),
  );

  return result.rows[0];
}

async function upsertHistory(
  connection: MysqlConnection,
  options: NPAMigrationRunOptions,
  statementCount: number,
): Promise<void> {
  await connection.query(
    [
      `INSERT INTO ${quoteQualifiedIdentifier(options.historyTable)} (name, checksum, adapter, statement_count)`,
      "VALUES (?, ?, ?, ?)",
      "ON DUPLICATE KEY UPDATE",
      "  checksum = VALUES(checksum),",
      "  adapter = VALUES(adapter),",
      "  applied_at = CURRENT_TIMESTAMP(3),",
      "  statement_count = VALUES(statement_count)",
    ].join("\n"),
    [MIGRATION_NAME, options.checksum, options.adapter, statementCount],
  );
}

async function insertHistory(
  connection: MysqlConnection,
  options: NPAMigrationDeployOptions,
  migration: NPAMigrationFile,
): Promise<void> {
  await connection.query(
    [
      `INSERT INTO ${quoteQualifiedIdentifier(options.historyTable)} (name, checksum, adapter, statement_count)`,
      "VALUES (?, ?, ?, ?)",
    ].join("\n"),
    [migration.name, migration.checksum, options.adapter, migration.statementCount],
  );
}

function toDeployResult(
  migration: NPAMigrationFile,
  status: "applied" | "pending" | "skipped",
): NPAMigrationDeployResult["migrations"][number] {
  return {
    name: migration.name,
    checksum: migration.checksum,
    statementCount: migration.statementCount,
    status,
  };
}

async function createPool(url: string): Promise<MysqlDriverConnection> {
  const mysql = await importDriver<{
    createPool: (uri: string) => MysqlDriverConnection;
  }>("mysql2/promise");

  return mysql.createPool(url);
}

function compileHistoryUpsertPreview(
  historyTable: string,
  checksum: string,
  statementCount: number,
): string {
  return [
    `INSERT INTO ${quoteQualifiedIdentifier(historyTable)} (name, checksum, adapter, statement_count) VALUES ('${MIGRATION_NAME}', '${checksum}', 'mysql', ${statementCount})`,
    "ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), adapter = VALUES(adapter), applied_at = CURRENT_TIMESTAMP(3), statement_count = VALUES(statement_count)",
  ].join("\n");
}

function compileMysqlCreateIndex(
  table: MigrationTableSchema,
  index: NPAMigrationIndexSchema,
): string {
  const unique = index.unique ? "UNIQUE " : "";

  return `CREATE ${unique}INDEX ${quoteQualifiedIdentifier(resolveIndexName(table, index))} ON ${qualifiedTable(table)} (${index.columns.map(quoteQualifiedIdentifier).join(", ")})`;
}

function resolveIndexName(
  table: MigrationTableSchema,
  index: NPAMigrationIndexSchema,
): string {
  if (index.name) {
    return index.name;
  }

  const prefix = index.unique ? "uidx" : "idx";
  return sanitizeIdentifier(`${prefix}_${table.tableName}_${index.columns.join("_")}`);
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function foreignKeyName(
  tableName: string,
  columns: string[],
  targetTableName: string,
): string {
  return shortenIdentifier(
    sanitizeIdentifier(`fk_${tableName}_${columns.join("_")}_${targetTableName}`),
    MAX_FOREIGN_KEY_IDENTIFIER_LENGTH,
  );
}

function shortenIdentifier(identifier: string, maxLength: number): string {
  if (identifier.length <= maxLength) {
    return identifier;
  }

  const hash = createHash("sha256").update(identifier).digest("hex").slice(0, 12);
  const prefixLength = maxLength - hash.length - 1;
  return `${identifier.slice(0, prefixLength)}_${hash}`;
}

function compareCurrentIndexes(left: CurrentIndexSchema, right: CurrentIndexSchema): number {
  return left.name.localeCompare(right.name);
}

function compareIndexes(left: NPAMigrationIndexSchema, right: NPAMigrationIndexSchema): number {
  return `${left.name ?? ""}.${left.unique ? "unique" : "index"}.${left.columns.join(",")}`.localeCompare(
    `${right.name ?? ""}.${right.unique ? "unique" : "index"}.${right.columns.join(",")}`,
  );
}

function compareForeignKeys(
  left: MigrationForeignKeySchema,
  right: MigrationForeignKeySchema,
): number {
  return left.name.localeCompare(right.name);
}

function qualifiedTable(table: Pick<MigrationTableSchema, "schema" | "tableName">): string {
  const quotedTable = quoteQualifiedIdentifier(table.tableName);

  return table.schema ? `${quoteQualifiedIdentifier(table.schema)}.${quotedTable}` : quotedTable;
}

function tableKey(table: Pick<MigrationTableSchema, "schema" | "tableName">): string {
  return `${table.schema ?? ""}.${table.tableName}`;
}

function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new Error("MySQL identifier must not be empty.");
  }

  return `\`${identifier.replace(/`/g, "``")}\``;
}

function compareEntities(
  left: NPAMigrationEntitySchema,
  right: NPAMigrationEntitySchema,
): number {
  return `${left.schema ?? ""}.${left.tableName}.${left.className}`.localeCompare(
    `${right.schema ?? ""}.${right.tableName}.${right.className}`,
  );
}

function compareTables(left: MigrationTableSchema, right: MigrationTableSchema): number {
  return tableKey(left).localeCompare(tableKey(right));
}

function compareCurrentColumns(left: CurrentColumnSchema, right: CurrentColumnSchema): number {
  return left.columnName.localeCompare(right.columnName);
}

function normalizeType(value: string): string {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part !== "undefined" && part !== "null")
    .join(" | ");
}

function normalizeMysqlTypeName(value: string): string {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();

  if (normalized === "integer") {
    return "int";
  }

  if (normalized === "bool" || normalized === "boolean") {
    return "tinyint(1)";
  }

  return normalized.replace(/^int\(\d+\)$/, "int");
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match, index) =>
    `${index === 0 ? "" : "_"}${match.toLowerCase()}`,
  );
}

function importDriver<TDriver>(specifier: string): Promise<TDriver> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<TDriver>;

  return dynamicImport(specifier);
}
