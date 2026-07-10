import type {
  MigrationColumnSchema,
  MigrationDeployOptions,
  MigrationDeployResult,
  MigrationEntitySchema,
  MigrationFile,
  MigrationIndexSchema,
  MigrationRename,
  MigrationResult,
  MigrationRunOptions,
} from "@node-persistence-api/core/adapter";
import {
  assertSafeMigrationStatements,
  buildDesiredMigrationTables,
  compareByName,
  compareColumnNames,
  compareMigrationIndexes,
  compareMigrationTables,
  createDownMigrationStatements,
  importDriver,
  normalizeTypeUnion as normalizeType,
  NPADatabaseError,
  NPAMigrationError,
  readArrayElementType,
  sanitizeMigrationIdentifier as sanitizeIdentifier,
  shortenIdentifier,
  tableKey,
  type MigrationForeignKeySchema,
  type MigrationTableSchema,
} from "@node-persistence-api/core/adapter";
import { MysqlConnection, MysqlDriverConnection } from "./mysql-connection";
import { normalizeMysqlResult } from "./mysql-result";

const MIGRATION_NAME = "schema";
const LOCK_KEY = "npa:migrations";
const MAX_FOREIGN_KEY_IDENTIFIER_LENGTH = 64;

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
  onDelete?: string;
  onUpdate?: string;
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
  deleteRule: string;
  updateRule: string;
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

    statements.push(
      ...compileMysqlIndexDiffStatements(
        table,
        currentTable.indexes,
        currentTable.foreignKeys,
      ),
    );
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
    const currentForeignKey = currentForeignKeys.get(foreignKey.name);

    if (currentForeignKey && isSameMysqlForeignKey(foreignKey, currentForeignKey)) {
      continue;
    }

    if (currentForeignKey) {
      statements.push(
        `ALTER TABLE ${qualifiedTable(table)} DROP FOREIGN KEY ${quoteQualifiedIdentifier(foreignKey.name)}`,
      );
    }

    statements.push(
      `ALTER TABLE ${qualifiedTable(table)} ADD ${compileMysqlForeignKeyConstraint(foreignKey)}`,
    );
  }

  return statements;
}

function isSameMysqlForeignKey(
  desired: MigrationForeignKeySchema,
  current: CurrentForeignKeySchema,
): boolean {
  return arraysEqual(desired.columns, current.columns) &&
    desired.referencedTable === current.referencedTable &&
    (!desired.referencedSchema || desired.referencedSchema === current.referencedSchema) &&
    arraysEqual(desired.referencedColumns, current.referencedColumns) &&
    normalizeMysqlReferentialAction(desired.onDelete) ===
      normalizeMysqlReferentialAction(current.onDelete) &&
    normalizeMysqlReferentialAction(desired.onUpdate) ===
      normalizeMysqlReferentialAction(current.onUpdate);
}

function compileMysqlIndexDiffStatements(
  table: MigrationTableSchema,
  currentIndexes: Map<string, CurrentIndexSchema>,
  currentForeignKeys: Map<string, CurrentForeignKeySchema>,
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
    if (
      !currentIndex.primary &&
      !desiredIndexNames.has(currentIndex.name) &&
      !isForeignKeySupportingIndex(currentIndex, currentForeignKeys)
    ) {
      statements.push(`ALTER TABLE ${qualifiedTable(table)} DROP INDEX ${quoteQualifiedIdentifier(currentIndex.name)}`);
    }
  }

  return statements;
}

function isForeignKeySupportingIndex(
  index: CurrentIndexSchema,
  foreignKeys: Map<string, CurrentForeignKeySchema>,
): boolean {
  return [...foreignKeys.values()].some((foreignKey) =>
    foreignKey.columns.every((column, position) => index.columns[position] === column),
  );
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

  if (column.enumValues?.length) {
    return isOrdinalEnumColumn(column) ? "INT" : "VARCHAR(255)";
  }

  if (normalized === "string") {
    return "VARCHAR(255)";
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
  return buildDesiredMigrationTables(entities, {
    defaultColumnType: (column) => defaultType(column, { identity: false }),
    foreignKeyIdentifierMaxLength: MAX_FOREIGN_KEY_IDENTIFIER_LENGTH,
  });
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
        "  kcu.CONSTRAINT_NAME AS constraintName,",
        "  kcu.COLUMN_NAME AS columnName,",
        "  kcu.REFERENCED_TABLE_SCHEMA AS referencedSchema,",
        "  kcu.REFERENCED_TABLE_NAME AS referencedTable,",
        "  kcu.REFERENCED_COLUMN_NAME AS referencedColumn,",
        "  kcu.ORDINAL_POSITION AS position,",
        "  rc.DELETE_RULE AS deleteRule,",
        "  rc.UPDATE_RULE AS updateRule",
        "FROM information_schema.KEY_COLUMN_USAGE kcu",
        "JOIN information_schema.REFERENTIAL_CONSTRAINTS rc",
        "  ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA",
        " AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME",
        `WHERE kcu.table_schema = ${table.schema ? "?" : "DATABASE()"} AND kcu.table_name = ?`,
        "  AND kcu.REFERENCED_TABLE_NAME IS NOT NULL",
        "ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
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
      onDelete: row.deleteRule,
      onUpdate: row.updateRule,
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

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function normalizeReferentialAction(
  value: string | undefined,
  fallback: string,
): string {
  return (value ?? fallback).replace(/_/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}

function normalizeMysqlReferentialAction(value: string | undefined): string {
  const normalized = normalizeReferentialAction(value, "RESTRICT");
  return normalized === "NO ACTION" ? "RESTRICT" : normalized;
}
