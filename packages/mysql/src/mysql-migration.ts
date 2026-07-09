import type {
  MigrationColumnSchema,
  MigrationDeployOptions,
  MigrationDeployResult,
  MigrationEntitySchema,
  MigrationFile,
  MigrationIndexSchema,
  MigrationRename,
  MigrationRelationSchema,
  MigrationResult,
  MigrationRunOptions,
} from "@node-persistence-api/core/adapter";
import {
  assertSafeMigrationStatements,
  compareByName,
  compareColumnNames,
  compareMigrationEntities,
  compareMigrationIndexes,
  compareMigrationTables,
  createDownMigrationStatements,
  foreignKeyName as buildForeignKeyName,
  importDriver,
  normalizeTypeUnion as normalizeType,
  NPADatabaseError,
  NPAMigrationError,
  readArrayElementType,
  sanitizeMigrationIdentifier as sanitizeIdentifier,
  shortenIdentifier,
  tableKey,
  toSnakeCase,
} from "@node-persistence-api/core/adapter";
import { MigrationRelationKind } from "@node-persistence-api/core/adapter";
import { MysqlConnection, MysqlDriverConnection } from "./mysql-connection";
import { normalizeMysqlResult } from "./mysql-result";

const MIGRATION_NAME = "schema";
const LOCK_KEY = "npa:migrations";
const MAX_FOREIGN_KEY_IDENTIFIER_LENGTH = 64;

interface MigrationTableSchema {
  tableName: string;
  schema?: string;
  columns: MigrationColumnSchema[];
  indexes: MigrationIndexSchema[];
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
  defaultValue?: string;
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

interface CurrentCheckConstraintSchema {
  name: string;
}

interface CurrentTableSchema {
  exists: boolean;
  columns: Map<string, CurrentColumnSchema>;
  indexes: Map<string, CurrentIndexSchema>;
  foreignKeys: Map<string, CurrentForeignKeySchema>;
  checkConstraints: Map<string, CurrentCheckConstraintSchema>;
}

interface MysqlColumnRow {
  columnName: string;
  columnType: string;
  columnDefault: string | null;
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

interface MysqlCheckConstraintRow {
  constraintName: string;
}

interface MysqlHistoryRow {
  name: string;
  checksum: string;
}

interface MysqlHistoryColumnRow {
  columnName: string;
}

type HistoryStatus = "applied" | "failed";

export interface MysqlMigrationCompileOptions {
  entities: MigrationEntitySchema[];
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
  entities: MigrationEntitySchema[],
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
    "  statement_count INT NOT NULL,",
    "  status VARCHAR(16) NOT NULL DEFAULT 'applied',",
    "  error_message TEXT",
    ")",
  ].join("\n");
}

export async function planMysqlMigration(
  options: MigrationRunOptions,
): Promise<MigrationResult> {
  if (!options.url) {
    if (options.renames?.length) {
      throw new NPAMigrationError("MySQL migration renames require a database url.", {
        code: "NPA_MIGRATION_RENAME_DATABASE_URL_REQUIRED",
      });
    }

    const statements = compileMysqlSchemaStatements(options.entities);
    const downStatements = createDownMigrationStatements(options.adapter, statements);

    return {
      status: "dry-run",
      checksum: options.checksum,
      statements,
      statementCount: statements.length,
      downStatements,
      downStatementCount: downStatements.length,
    };
  }

  const connection = new MysqlConnection(await createPool(options.url));

  try {
    const namespaceStatements = compileMysqlNamespaceStatements(options.entities);
    const desiredTables = buildDesiredTables(options.entities);
    const currentTables = await readCurrentTables(
      connection,
      migrationReadTables(desiredTables, options.renames),
    );
    const renameStatements = compileMysqlRenameStatements(
      currentTables,
      options.renames ?? [],
    );
    const statements = [
      ...namespaceStatements,
      ...renameStatements,
      ...compileMysqlTableDiffStatements(desiredTables, currentTables),
    ];
    const downStatements = createDownMigrationStatements(options.adapter, statements);

    return {
      status: "dry-run",
      checksum: options.checksum,
      statements,
      statementCount: statements.length,
      downStatements,
      downStatementCount: downStatements.length,
    };
  } finally {
    await connection.close();
  }
}

export async function migrateMysql(
  options: MigrationRunOptions,
): Promise<MigrationResult> {
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
      downStatements: plan.downStatements,
      downStatementCount: plan.downStatementCount,
    };
  }

  if (!options.url) {
    throw new NPAMigrationError("MySQL migration requires a database url.", {
      code: "NPA_MIGRATION_DATABASE_URL_REQUIRED",
    });
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
        downStatements: plan.downStatements,
        downStatementCount: plan.downStatementCount,
      };
    }

    await acquireLock(connection);
    await ensureMysqlHistoryTable(connection, options.historyTable);
    let statementCount = 0;

    try {
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
      const currentTables = await readCurrentTables(
        connection,
        migrationReadTables(desiredTables, options.renames),
      );
      const renameStatements = compileMysqlRenameStatements(
        currentTables,
        options.renames ?? [],
      );
      const tableStatements = [
        ...renameStatements,
        ...compileMysqlTableDiffStatements(desiredTables, currentTables),
      ];
      const migrationStatements = [...namespaceStatements, ...tableStatements];
      statementCount = migrationStatements.length;

      assertSafeMigrationStatements(tableStatements, options);

      for (const statement of tableStatements) {
        await connection.query(statement);
      }

      await upsertHistory(connection, options, statementCount, "applied");

      return {
        status: "applied",
        checksum: options.checksum,
        previousChecksum,
        statements: migrationStatements,
        statementCount: migrationStatements.length,
      };
    } catch (error) {
      await recordHistoryFailure(
        connection,
        options,
        MIGRATION_NAME,
        options.checksum,
        statementCount,
        error,
      );
      throw error;
    }
  } finally {
    await Promise.resolve(connection.query("SELECT RELEASE_LOCK(?)", [LOCK_KEY])).catch(
      () => undefined,
    );
    await connection.close();
  }
}

export async function deployMysqlMigrations(
  options: MigrationDeployOptions,
): Promise<MigrationDeployResult> {
  if (!options.url) {
    throw new NPAMigrationError("MySQL migration deploy requires a database url.", {
      code: "NPA_MIGRATION_DATABASE_URL_REQUIRED",
    });
  }

  const connection = new MysqlConnection(await createPool(options.url));

  try {
    await acquireLock(connection);
    await ensureMysqlHistoryTable(connection, options.historyTable);
    let activeMigration: MigrationFile | undefined;

    try {
      await assertNoMysqlHistoryDrift(connection, options);
      const results: MigrationDeployResult["migrations"] = [];
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
            throw new NPAMigrationError(
              `Migration ${migration.name} checksum mismatch. The migration file changed after it was applied.`,
              {
                code: "NPA_MIGRATION_CHECKSUM_MISMATCH",
                details: {
                  migrationName: migration.name,
                  historyChecksum: existing.checksum,
                  fileChecksum: migration.checksum,
                },
              },
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

        activeMigration = migration;
        assertSafeMigrationStatements(migration.statements, options);

        for (const statement of migration.statements) {
          await connection.query(statement);
        }

        await insertHistory(connection, options, migration, "applied");
        activeMigration = undefined;
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
    } catch (error) {
      if (activeMigration) {
        await recordHistoryFailure(
          connection,
          options,
          activeMigration.name,
          activeMigration.checksum,
          activeMigration.statementCount,
          error,
        );
      }
      throw error;
    }
  } finally {
    await Promise.resolve(connection.query("SELECT RELEASE_LOCK(?)", [LOCK_KEY])).catch(
      () => undefined,
    );
    await connection.close();
  }
}

function compileMysqlNamespaceStatements(entities: MigrationEntitySchema[]): string[] {
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
      const expectedDefault = normalizeDesiredDefault(column);
      const currentDefault = normalizeMysqlDefault(
        currentColumn.defaultValue,
        column,
      );

      if (
        !column.primary &&
        (currentType !== expectedType ||
          currentColumn.nullable !== expectedNullable ||
          currentDefault !== expectedDefault)
      ) {
        statements.push(
          `ALTER TABLE ${qualifiedTable(table)} MODIFY COLUMN ${quoteQualifiedIdentifier(column.columnName)} ${columnDefinition(column, { inlinePrimary: false })}`,
        );
      }
    }

    const desiredColumnNames = new Set(table.columns.map((column) => column.columnName));

    for (const column of [...currentTable.columns.values()].sort(compareColumnNames)) {
      if (!desiredColumnNames.has(column.columnName)) {
        statements.push(
          `ALTER TABLE ${qualifiedTable(table)} DROP COLUMN ${quoteQualifiedIdentifier(column.columnName)}`,
        );
      }
    }

    statements.push(...compileMysqlIndexDiffStatements(table, currentTable.indexes));
    statements.push(
      ...compileMysqlCheckConstraintDiffStatements(
        table,
        currentTable.checkConstraints,
      ),
    );
    foreignKeyStatements.push(
      ...compileMysqlForeignKeyDiffStatements(table, currentTable.foreignKeys),
    );
  }

  return [...statements, ...foreignKeyStatements];
}

function migrationReadTables(
  desiredTables: MigrationTableSchema[],
  renames: MigrationRename[] | undefined,
): MigrationTableSchema[] {
  const tables = new Map(desiredTables.map((table) => [tableKey(table), table]));

  for (const rename of renames ?? []) {
    const table = rename.kind === "table" ? rename.from : rename.table;
    const key = tableKey(table);

    if (!tables.has(key)) {
      tables.set(key, {
        ...table,
        columns: [],
        indexes: [],
        foreignKeys: [],
      });
    }
  }

  return [...tables.values()].sort(compareMigrationTables);
}

function compileMysqlRenameStatements(
  currentTables: Map<string, CurrentTableSchema>,
  renames: MigrationRename[],
): string[] {
  const statements: string[] = [];

  for (const rename of renames) {
    if (rename.kind === "table") {
      const fromKey = tableKey(rename.from);
      const toKey = tableKey(rename.to);
      const fromTable = currentTables.get(fromKey);
      const toTable = currentTables.get(toKey);

      if (fromTable?.exists && !toTable?.exists) {
        statements.push(
          `RENAME TABLE ${qualifiedTable(rename.from)} TO ${qualifiedTable(rename.to)}`,
        );
        currentTables.set(toKey, fromTable);
        currentTables.delete(fromKey);
      }

      continue;
    }

    const table = currentTables.get(tableKey(rename.table));

    if (!table?.exists) {
      continue;
    }

    const source = table.columns.get(rename.from);
    const target = table.columns.get(rename.to);

    if (source && !target) {
      statements.push(
        `ALTER TABLE ${qualifiedTable(rename.table)} RENAME COLUMN ${quoteQualifiedIdentifier(rename.from)} TO ${quoteQualifiedIdentifier(rename.to)}`,
      );
      table.columns.delete(rename.from);
      table.columns.set(rename.to, {
        ...source,
        columnName: rename.to,
      });
    }
  }

  return statements;
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

  for (const foreignKey of [...table.foreignKeys].sort(compareByName)) {
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

  for (const index of [...table.indexes].sort(compareMigrationIndexes)) {
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

  for (const currentIndex of [...currentIndexes.values()].sort(compareByName)) {
    if (!currentIndex.primary && !desiredIndexNames.has(currentIndex.name)) {
      statements.push(`ALTER TABLE ${qualifiedTable(table)} DROP INDEX ${quoteQualifiedIdentifier(currentIndex.name)}`);
    }
  }

  return statements;
}

function compileMysqlCheckConstraintDiffStatements(
  table: MigrationTableSchema,
  currentChecks: Map<string, CurrentCheckConstraintSchema>,
): string[] {
  const statements: string[] = [];
  const desiredChecks = desiredEnumCheckConstraints(table);
  const desiredNames = new Set(desiredChecks.map((check) => check.name));
  const prefixes = table.columns.map((column) =>
    enumCheckConstraintPrefix(table, column),
  );

  for (const current of [...currentChecks.values()].sort(compareByName)) {
    if (
      prefixes.some((prefix) => current.name.startsWith(`${prefix}_`)) &&
      !desiredNames.has(current.name)
    ) {
      statements.push(
        `ALTER TABLE ${qualifiedTable(table)} DROP CHECK ${quoteQualifiedIdentifier(current.name)}`,
      );
    }
  }

  for (const check of desiredChecks) {
    if (!currentChecks.has(check.name)) {
      statements.push(
        `ALTER TABLE ${qualifiedTable(table)} ADD ${compileMysqlCheckConstraint(check)}`,
      );
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
  const checkLines = desiredEnumCheckConstraints(table).map(
    (check) => `  ${compileMysqlCheckConstraint(check)}`,
  );

  return [
    `CREATE TABLE IF NOT EXISTS ${qualifiedTable(table)} (`,
    [...columnLines, ...primaryKeyLines, ...checkLines].join(",\n"),
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

function compileMysqlCheckConstraint(
  check: { name: string; column: MigrationColumnSchema },
): string {
  return [
    `CONSTRAINT ${quoteQualifiedIdentifier(check.name)}`,
    `CHECK (${quoteQualifiedIdentifier(check.column.columnName)} IN (${enumCheckLiterals(check.column)}))`,
  ].join(" ");
}

function desiredEnumCheckConstraints(
  table: MigrationTableSchema,
): Array<{ name: string; column: MigrationColumnSchema }> {
  return table.columns
    .filter((column) => column.enumValues?.length && !isNativeEnumColumn(column))
    .map((column) => ({
      name: enumCheckConstraintName(table, column),
      column,
    }))
    .sort(compareByName);
}

function enumCheckConstraintPrefix(
  table: MigrationTableSchema,
  column: MigrationColumnSchema,
): string {
  return shortenIdentifier(
    sanitizeIdentifier(`chk_${table.tableName}_${column.columnName}_enum`),
    MAX_FOREIGN_KEY_IDENTIFIER_LENGTH - 9,
  );
}

function enumCheckConstraintName(
  table: MigrationTableSchema,
  column: MigrationColumnSchema,
): string {
  return shortenIdentifier(
    `${enumCheckConstraintPrefix(table, column)}_${enumValuesHash([
      column.enumType ?? "STRING",
      ...(column.enumValues ?? []),
    ])}`,
    MAX_FOREIGN_KEY_IDENTIFIER_LENGTH,
  );
}

function isNativeEnumColumn(column: MigrationColumnSchema): boolean {
  return !!column.enumValues?.length && column.enumType === "NATIVE";
}

function isOrdinalEnumColumn(column: MigrationColumnSchema): boolean {
  return !!column.enumValues?.length && column.enumType === "ORDINAL";
}

function enumSqlLiterals(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

function enumCheckLiterals(column: MigrationColumnSchema): string {
  if (isOrdinalEnumColumn(column)) {
    return (column.enumValues ?? []).map((_, index) => String(index)).join(", ");
  }

  return enumSqlLiterals(column.enumValues ?? []);
}

function enumValuesHash(values: string[]): string {
  let hash = 0;

  for (const char of values.join("\u001f")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

function columnDefinition(
  column: MigrationColumnSchema,
  options: { inlinePrimary: boolean },
): string {
  if (column.primary && column.generationStrategy === "SEQUENCE") {
    throw new NPAMigrationError("MySQL does not support GenerationStrategy.SEQUENCE.", {
      code: "NPA_UNSUPPORTED_GENERATION_STRATEGY",
      details: { generationStrategy: column.generationStrategy },
    });
  }

  const dbType = columnType(column, { identity: options.inlinePrimary });
  const constraints = options.inlinePrimary && column.primary
    ? " PRIMARY KEY"
    : column.nullable
      ? ""
      : " NOT NULL";
  const defaultClause = columnDefaultClause(column);

  if (column.primary && column.generationStrategy === "UUID") {
    return `${dbType}${defaultClause}${constraints}`;
  }

  return `${dbType}${constraints}${defaultClause}`;
}

function columnAlterType(column: MigrationColumnSchema): string {
  return columnType(column, { identity: false });
}

function columnType(
  column: MigrationColumnSchema,
  options: { identity: boolean },
): string {
  if (isNativeEnumColumn(column)) {
    return `ENUM(${enumSqlLiterals(column.enumValues ?? [])})`;
  }

  return column.dbType ?? defaultType(column, { identity: options.identity });
}

function normalizeDesiredDefault(
  column: MigrationColumnSchema,
): string | undefined {
  if (column.defaultCurrentTimestamp) {
    return "raw:current_timestamp";
  }

  const value = column.defaultValue;

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return `string:${value}`;
  }

  if (typeof value === "boolean") {
    return `boolean:${value}`;
  }

  return `number:${value}`;
}

function normalizeMysqlDefault(
  value: string | undefined,
  column: MigrationColumnSchema,
): string | undefined {
  const desiredValue = column.defaultValue;

  if (value === undefined || desiredValue === null) {
    return undefined;
  }

  if (column.defaultCurrentTimestamp) {
    return /^current_timestamp(?:\(\d+\))?$/i.test(value)
      ? "raw:current_timestamp"
      : `raw:${value}`;
  }

  if (typeof desiredValue === "boolean") {
    return `boolean:${value === "1" || value.toLowerCase() === "true"}`;
  }

  if (typeof desiredValue === "number") {
    return `number:${Number(value)}`;
  }

  if (typeof desiredValue === "string") {
    return `string:${value}`;
  }

  return `raw:${value}`;
}

function columnDefaultClause(column: MigrationColumnSchema): string {
  if (column.primary && column.generationStrategy === "UUID") {
    return " DEFAULT (UUID())";
  }

  if (column.defaultCurrentTimestamp) {
    return " DEFAULT CURRENT_TIMESTAMP(3)";
  }

  if (column.defaultValue === undefined) {
    return "";
  }

  return ` DEFAULT ${renderColumnDefault(column)}`;
}

function renderColumnDefault(column: MigrationColumnSchema): string {
  const value = column.defaultValue;

  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (value === null || value === undefined) {
    return "NULL";
  }

  return String(value);
}

function defaultType(
  column: MigrationColumnSchema,
  options: { identity: boolean },
): string {
  const normalized = normalizeType(column.tsType);
  const arrayElementType = readArrayElementType(column.tsType);

  if (
    column.primary &&
    normalized === "number" &&
    options.identity &&
    column.generationStrategy === "AUTO_INCREMENT"
  ) {
    return "INT AUTO_INCREMENT";
  }

  if (column.primary && column.generationStrategy === "UUID") {
    return "CHAR(36)";
  }

  if (column.array || arrayElementType) {
    return "JSON";
  }

  if (normalized === "string") {
    return "VARCHAR(255)";
  }

  if (column.enumValues?.length) {
    return isOrdinalEnumColumn(column) ? "INT" : "VARCHAR(255)";
  }

  if (normalized === "number") {
    return "INT";
  }

  if (["bigint", "biginteger"].includes(normalized.toLowerCase())) {
    return "BIGINT";
  }

  if (normalized === "boolean") {
    return "BOOLEAN";
  }

  if (normalized === "Date") {
    return "DATETIME(3)";
  }

  throw new NPAMigrationError(
    `Unsupported MySQL migration type "${column.tsType}" for ${column.propertyName}. Use @Column({ type: "..." }).`,
    {
      code: "NPA_MIGRATION_UNSUPPORTED_DDL",
      details: { propertyName: column.propertyName, tsType: column.tsType },
    },
  );
}

function buildDesiredTables(entities: MigrationEntitySchema[]): MigrationTableSchema[] {
  const tables = new Map<string, MigrationTableSchema>();
  const sortedEntities = [...entities].sort(compareMigrationEntities);
  const byClassName = new Map(sortedEntities.map((entity) => [entity.className, entity]));

  for (const entity of sortedEntities) {
    const table = entityTable(entity, byClassName);
    tables.set(tableKey(table), table);
  }

  for (const table of buildJoinTables(sortedEntities)) {
    tables.set(tableKey(table), table);
  }

  return [...tables.values()].sort(compareMigrationTables);
}

function entityTable(
  entity: MigrationEntitySchema,
  byClassName: Map<string, MigrationEntitySchema>,
): MigrationTableSchema {
  const columns = new Map(entity.columns.map((column) => [column.columnName, column]));
  const indexes = [...(entity.indexes ?? [])];
  const foreignKeys: MigrationForeignKeySchema[] = [];

  for (const relation of entity.relations ?? []) {
    if (!isOwningForeignKeyRelation(relation)) {
      continue;
    }

    const target = byClassName.get(relation.targetClassName);

    if (!target) {
      throw new NPAMigrationError(
        `@${relation.kind === MigrationRelationKind.ONE_TO_ONE ? "OneToOne" : "ManyToOne"} for ${entity.className}.${relation.propertyName} targets unknown entity ${relation.targetClassName}.`,
        {
          code: "NPA_RELATION_NOT_FOUND",
          details: { entity: entity.className, relation: relation.propertyName, target: relation.targetClassName },
        },
      );
    }

    const targetPrimaryColumns = primaryColumns(target);
    const joinColumns = relationJoinColumnNames(relation, targetPrimaryColumns);

    for (const [index, joinColumn] of joinColumns.entries()) {
      const column = {
        ...relationColumn(targetPrimaryColumns[index], joinColumn),
        nullable: relation.nullable ?? true,
      };
      columns.set(joinColumn, column);
    }

    if (relation.kind === MigrationRelationKind.ONE_TO_ONE) {
      indexes.push({
        columns: joinColumns,
        unique: true,
      });
    }
    foreignKeys.push({
      name: relation.foreignKeyName ??
        buildForeignKeyName(entity.tableName, joinColumns, target.tableName, MAX_FOREIGN_KEY_IDENTIFIER_LENGTH),
      columns: joinColumns,
      referencedSchema: target.schema,
      referencedTable: target.tableName,
      referencedColumns: targetPrimaryColumns.map((column) => column.columnName),
      onDelete: relation.onDelete,
      onUpdate: relation.onUpdate,
    });
  }

  return {
    tableName: entity.tableName,
    schema: entity.schema,
    columns: [...columns.values()],
    indexes,
    foreignKeys,
  };
}

function isOwningForeignKeyRelation(relation: { kind: MigrationRelationKind; mappedBy?: string }): boolean {
  return relation.kind === MigrationRelationKind.MANY_TO_ONE ||
    (relation.kind === MigrationRelationKind.ONE_TO_ONE && !relation.mappedBy);
}

function buildJoinTables(entities: MigrationEntitySchema[]): MigrationTableSchema[] {
  const byClassName = new Map(entities.map((entity) => [entity.className, entity]));
  const tables: MigrationTableSchema[] = [];

  for (const entity of entities) {
    for (const relation of entity.relations ?? []) {
      if (relation.kind !== MigrationRelationKind.MANY_TO_MANY) {
        continue;
      }

      const target = byClassName.get(relation.targetClassName);

      if (!target) {
        throw new NPAMigrationError(
          `@ManyToMany for ${entity.className}.${relation.propertyName} targets unknown entity ${relation.targetClassName}.`,
          {
            code: "NPA_RELATION_NOT_FOUND",
            details: { entity: entity.className, relation: relation.propertyName, target: relation.targetClassName },
          },
        );
      }

      const joinTable = resolveJoinTable(entity, target, relation.joinTable);
      const sourcePrimaryColumns = primaryColumns(entity);
      const targetPrimaryColumns = primaryColumns(target);
      const sourceColumnNames = joinColumnNames(entity, sourcePrimaryColumns);
      const targetColumnNames = joinColumnNames(target, targetPrimaryColumns);

      tables.push({
        ...joinTable,
        columns: [
          ...sourcePrimaryColumns.map((column, index) =>
            relationColumn(column, sourceColumnNames[index])),
          ...targetPrimaryColumns.map((column, index) =>
            relationColumn(column, targetColumnNames[index])),
        ],
        indexes: [],
        foreignKeys: [
          {
            name: buildForeignKeyName(joinTable.tableName, sourceColumnNames, entity.tableName, MAX_FOREIGN_KEY_IDENTIFIER_LENGTH),
            columns: sourceColumnNames,
            referencedSchema: entity.schema,
            referencedTable: entity.tableName,
            referencedColumns: sourcePrimaryColumns.map((column) => column.columnName),
          },
          {
            name: buildForeignKeyName(joinTable.tableName, targetColumnNames, target.tableName, MAX_FOREIGN_KEY_IDENTIFIER_LENGTH),
            columns: targetColumnNames,
            referencedSchema: target.schema,
            referencedTable: target.tableName,
            referencedColumns: targetPrimaryColumns.map((column) => column.columnName),
          },
        ],
        primaryKey: [...sourceColumnNames, ...targetColumnNames],
      });
    }
  }

  return tables;
}

function relationColumn(
  source: MigrationColumnSchema,
  columnName: string,
): MigrationColumnSchema {
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
  source: MigrationEntitySchema,
  target: MigrationEntitySchema,
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

function relationJoinColumnNames(
  relation: MigrationRelationSchema,
  targetPrimaryColumns: MigrationColumnSchema[],
): string[] {
  const explicit = relation.joinColumns ?? (
    relation.joinColumn ? [relation.joinColumn] : undefined
  );

  if (explicit && explicit.length !== targetPrimaryColumns.length) {
    throw new NPAMigrationError(
      `@${relation.kind === MigrationRelationKind.ONE_TO_ONE ? "OneToOne" : "ManyToOne"} ${relation.propertyName} defines ${explicit.length} join column(s), but target has ${targetPrimaryColumns.length} @Id column(s).`,
      {
        code: "NPA_MIGRATION_SCHEMA_PARSE_FAILED",
        details: {
          actualJoinColumns: explicit.length,
          expectedJoinColumns: targetPrimaryColumns.length,
          relation: relation.propertyName,
        },
      },
    );
  }

  return targetPrimaryColumns.map((column, index) =>
    explicit?.[index] ?? `${relation.propertyName}_${column.columnName}`);
}

function joinColumnNames(
  entity: MigrationEntitySchema,
  primaryColumns: MigrationColumnSchema[],
): string[] {
  const prefix = `${toSnakeCase(entity.className)}_`;

  return primaryColumns.map((primary) =>
    primary.columnName.startsWith(prefix)
      ? primary.columnName
      : `${prefix}${primary.columnName}`);
}

function primaryColumns(entity: MigrationEntitySchema): MigrationColumnSchema[] {
  const primary = entity.columns.filter((column) => column.primary);

  if (primary.length === 0) {
    throw new NPAMigrationError(`${entity.className} must declare an @Id column before it can be migrated.`, {
      code: "NPA_MIGRATION_ENTITY_ID_REQUIRED",
      details: { entity: entity.className },
    });
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
          "  COLUMN_DEFAULT AS columnDefault,",
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
        ...(row.columnDefault !== null
          ? { defaultValue: row.columnDefault }
          : {}),
        nullable: row.isNullable === "YES",
      });
    }

    const indexes = await readCurrentIndexes(connection, table);
    const foreignKeys = await readCurrentForeignKeys(connection, table);
    const checkConstraints = await readCurrentCheckConstraints(connection, table);

    currentTables.set(tableKey(table), {
      exists: columns.size > 0,
      columns,
      indexes,
      foreignKeys,
      checkConstraints,
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

async function readCurrentCheckConstraints(
  connection: MysqlConnection,
  table: MigrationTableSchema,
): Promise<Map<string, CurrentCheckConstraintSchema>> {
  const result = normalizeMysqlResult<MysqlCheckConstraintRow>(
    await connection.query(
      [
        "SELECT",
        "  CONSTRAINT_NAME AS constraintName",
        "FROM information_schema.table_constraints",
        `WHERE table_schema = ${table.schema ? "?" : "DATABASE()"} AND table_name = ?`,
        "  AND CONSTRAINT_TYPE = 'CHECK'",
      ].join("\n"),
      table.schema ? [table.schema, table.tableName] : [table.tableName],
    ),
  );
  const constraints = new Map<string, CurrentCheckConstraintSchema>();

  for (const row of result.rows) {
    constraints.set(row.constraintName, { name: row.constraintName });
  }

  return constraints;
}

async function acquireLock(connection: MysqlConnection): Promise<void> {
  const result = normalizeMysqlResult<{ acquired: number }>(
    await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [LOCK_KEY]),
  );
  const acquired = result.rows[0]?.acquired;

  if (acquired !== 1) {
    throw new NPAMigrationError("Could not acquire NPA MySQL migration lock.", {
      code: "NPA_MIGRATION_LOCK_FAILED",
    });
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
      `SELECT name, checksum FROM ${quoteQualifiedIdentifier(historyTable)} WHERE name = ? AND status = 'applied' LIMIT 1`,
      [name],
    ),
  );

  return result.rows[0];
}

async function readHistoryRecords(
  connection: MysqlConnection,
  historyTable: string,
): Promise<MysqlHistoryRow[]> {
  const result = normalizeMysqlResult<MysqlHistoryRow>(
    await connection.query(
      `SELECT name, checksum FROM ${quoteQualifiedIdentifier(historyTable)} WHERE status = 'applied' ORDER BY name`,
    ),
  );

  return result.rows;
}

async function assertNoMysqlHistoryDrift(
  connection: MysqlConnection,
  options: MigrationDeployOptions,
): Promise<void> {
  if (options.allowDrift) {
    return;
  }

  const localMigrations = new Map(
    options.migrations.map((migration) => [migration.name, migration.checksum]),
  );
  const unknown = (await readHistoryRecords(connection, options.historyTable))
    .filter((record) => record.name !== MIGRATION_NAME)
    .filter((record) => !localMigrations.has(record.name));

  if (unknown.length === 0) {
    return;
  }

  throw new NPAMigrationError(
    `Migration history drift detected. Applied migration(s) missing locally: ${unknown.map((record) => record.name).join(", ")}. Use --allow-drift to bypass.`,
    {
      code: "NPA_MIGRATION_HISTORY_MISMATCH",
      details: {
        missingMigrations: unknown.map((record) => record.name),
      },
    },
  );
}

async function upsertHistory(
  connection: MysqlConnection,
  options: MigrationRunOptions,
  statementCount: number,
  status: HistoryStatus,
  errorMessage?: string,
): Promise<void> {
  await writeHistory(
    connection,
    options.historyTable,
    MIGRATION_NAME,
    options.checksum,
    options.adapter,
    statementCount,
    status,
    errorMessage,
  );
}

async function insertHistory(
  connection: MysqlConnection,
  options: MigrationDeployOptions,
  migration: MigrationFile,
  status: HistoryStatus,
  errorMessage?: string,
): Promise<void> {
  await writeHistory(
    connection,
    options.historyTable,
    migration.name,
    migration.checksum,
    options.adapter,
    migration.statementCount,
    status,
    errorMessage,
  );
}

async function ensureMysqlHistoryTable(
  connection: MysqlConnection,
  historyTable: string,
): Promise<void> {
  await ensureMysqlHistorySchema(connection, historyTable);
  await connection.query(compileMysqlHistoryTable(historyTable));
  const existingColumns = await readMysqlHistoryColumns(connection, historyTable);

  if (!existingColumns.has("status")) {
    await connection.query(
      `ALTER TABLE ${quoteQualifiedIdentifier(historyTable)} ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'applied'`,
    );
  }

  if (!existingColumns.has("error_message")) {
    await connection.query(
      `ALTER TABLE ${quoteQualifiedIdentifier(historyTable)} ADD COLUMN error_message TEXT`,
    );
  }
}

async function ensureMysqlHistorySchema(
  connection: MysqlConnection,
  historyTable: string,
): Promise<void> {
  const schema = parseMysqlQualifiedIdentifier(historyTable).schema;

  if (schema) {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteQualifiedIdentifier(schema)}`,
    );
  }
}

async function readMysqlHistoryColumns(
  connection: MysqlConnection,
  historyTable: string,
): Promise<Set<string>> {
  const table = parseMysqlQualifiedIdentifier(historyTable);
  const result = normalizeMysqlResult<MysqlHistoryColumnRow>(
    await connection.query(
      [
        "SELECT COLUMN_NAME AS columnName",
        "FROM information_schema.columns",
        `WHERE table_schema = ${table.schema ? "?" : "DATABASE()"} AND table_name = ?`,
      ].join("\n"),
      table.schema ? [table.schema, table.tableName] : [table.tableName],
    ),
  );

  return new Set(result.rows.map((row) => row.columnName));
}

async function recordHistoryFailure(
  connection: MysqlConnection,
  options: Pick<MigrationRunOptions, "adapter" | "historyTable">,
  name: string,
  checksum: string,
  statementCount: number,
  error: unknown,
): Promise<void> {
  await writeHistory(
    connection,
    options.historyTable,
    name,
    checksum,
    options.adapter,
    statementCount,
    "failed",
    toHistoryErrorMessage(error),
  );
}

async function writeHistory(
  connection: MysqlConnection,
  historyTable: string,
  name: string,
  checksum: string,
  adapter: string,
  statementCount: number,
  status: HistoryStatus,
  errorMessage?: string,
): Promise<void> {
  await connection.query(
    [
      `INSERT INTO ${quoteQualifiedIdentifier(historyTable)} (name, checksum, adapter, statement_count, status, error_message)`,
      "VALUES (?, ?, ?, ?, ?, ?)",
      "ON DUPLICATE KEY UPDATE",
      "  checksum = VALUES(checksum),",
      "  adapter = VALUES(adapter),",
      "  applied_at = CURRENT_TIMESTAMP(3),",
      "  statement_count = VALUES(statement_count),",
      "  status = VALUES(status),",
      "  error_message = VALUES(error_message)",
    ].join("\n"),
    [name, checksum, adapter, statementCount, status, errorMessage ?? null],
  );
}

function toDeployResult(
  migration: MigrationFile,
  status: "applied" | "pending" | "skipped",
): MigrationDeployResult["migrations"][number] {
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
    `INSERT INTO ${quoteQualifiedIdentifier(historyTable)} (name, checksum, adapter, statement_count, status, error_message) VALUES ('${MIGRATION_NAME}', '${checksum}', 'mysql', ${statementCount}, 'applied', NULL)`,
    "ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), adapter = VALUES(adapter), applied_at = CURRENT_TIMESTAMP(3), statement_count = VALUES(statement_count), status = VALUES(status), error_message = VALUES(error_message)",
  ].join("\n");
}

function toHistoryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

function compileMysqlCreateIndex(
  table: MigrationTableSchema,
  index: MigrationIndexSchema,
): string {
  const unique = index.unique ? "UNIQUE " : "";

  return `CREATE ${unique}INDEX ${quoteQualifiedIdentifier(resolveIndexName(table, index))} ON ${qualifiedTable(table)} (${index.columns.map(quoteQualifiedIdentifier).join(", ")})`;
}

function resolveIndexName(
  table: MigrationTableSchema,
  index: MigrationIndexSchema,
): string {
  if (index.name) {
    return index.name;
  }

  const prefix = index.unique ? "uidx" : "idx";
  return sanitizeIdentifier(`${prefix}_${table.tableName}_${index.columns.join("_")}`);
}

function qualifiedTable(table: Pick<MigrationTableSchema, "schema" | "tableName">): string {
  const quotedTable = quoteQualifiedIdentifier(table.tableName);

  return table.schema ? `${quoteQualifiedIdentifier(table.schema)}.${quotedTable}` : quotedTable;
}

function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new NPADatabaseError("MySQL identifier must not be empty.", {
      code: "NPA_DATABASE_IDENTIFIER_INVALID",
    });
  }

  return `\`${identifier.replace(/`/g, "``")}\``;
}

function unquoteIdentifier(identifier: string): string {
  return identifier.replace(/^`|`$/g, "").replace(/``/g, "`");
}

function parseMysqlQualifiedIdentifier(identifier: string): {
  schema?: string;
  tableName: string;
} {
  const parts = identifier.split(".").map(unquoteIdentifier);
  const tableName = parts.at(-1) ?? identifier;

  return {
    schema: parts.length > 1 ? parts.at(-2) : undefined,
    tableName,
  };
}


function normalizeMysqlTypeName(value: string): string {
  if (/^enum\s*\(/i.test(value.trim())) {
    return value.trim().replace(/^enum/i, "enum").replace(/,\s*/g, ", ");
  }

  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();

  if (normalized === "integer") {
    return "int";
  }

  if (normalized === "bool" || normalized === "boolean") {
    return "tinyint(1)";
  }

  return normalized.replace(/^int\(\d+\)$/, "int");
}
