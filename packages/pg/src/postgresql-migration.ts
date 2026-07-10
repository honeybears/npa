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
import { PostgresqlConnection, PostgresqlDriverConnection } from "./postgresql-connection";

const MIGRATION_NAME = "schema";
const LOCK_KEY = "npa:migrations";
const MAX_FOREIGN_KEY_IDENTIFIER_LENGTH = 63;
const INDEX_COLUMN_SEPARATOR = "\u001f";

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

interface PostgresqlColumnRow {
  columnName: string;
  dataType: string;
  udtName: string;
  characterMaximumLength: number | null;
  columnDefault: string | null;
  isNullable: "YES" | "NO";
}

interface PostgresqlIndexRow {
  indexName: string;
  columns: string;
  unique: boolean;
  primary: boolean;
}

interface PostgresqlForeignKeyRow {
  constraintName: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

interface PostgresqlCheckConstraintRow {
  constraintName: string;
}

interface PostgresqlHistoryRow {
  name: string;
  checksum: string;
}

type HistoryStatus = "applied" | "failed";

export interface PostgresqlMigrationCompileOptions {
  entities: MigrationEntitySchema[];
  historyTable?: string;
  checksum?: string;
}

export function compilePostgresqlMigrationStatements(
  options: PostgresqlMigrationCompileOptions,
): string[] {
  return [
    compilePostgresqlHistoryTable(options.historyTable ?? "_npa_migrations"),
    ...compilePostgresqlSchemaStatements(options.entities),
  ];
}

export function compilePostgresqlSchemaStatements(
  entities: MigrationEntitySchema[],
): string[] {
  const desiredTables = buildDesiredTables(entities);

  return [
    ...compilePostgresqlNamespaceStatements(entities),
    ...desiredTables.flatMap((table) => compilePostgresqlCreateTableStatements(table)),
    ...desiredTables.flatMap((table) => compilePostgresqlForeignKeyDiffStatements(table, new Map())),
  ];
}

export function compilePostgresqlHistoryTable(historyTable: string): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${quoteQualifiedIdentifier(historyTable)} (`,
    "  name TEXT PRIMARY KEY,",
    "  checksum TEXT NOT NULL,",
    "  adapter TEXT NOT NULL,",
    "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "  statement_count INTEGER NOT NULL,",
    "  status TEXT NOT NULL DEFAULT 'applied',",
    "  error_message TEXT",
    ")",
  ].join("\n");
}

export async function planPostgresqlMigration(
  options: MigrationRunOptions,
): Promise<MigrationResult> {
  if (!options.url) {
    if (options.renames?.length) {
      throw new NPAMigrationError("PostgreSQL migration renames require a database url.", {
        code: "NPA_MIGRATION_RENAME_DATABASE_URL_REQUIRED",
      });
    }

    const statements = compilePostgresqlSchemaStatements(options.entities);
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

  const connection = new PostgresqlConnection(await createPool(options.url));

  try {
    const namespaceStatements = compilePostgresqlNamespaceStatements(options.entities);
    const desiredTables = buildDesiredTables(options.entities);
    const currentTables = await readCurrentTables(
      connection,
      migrationReadTables(desiredTables, options.renames),
    );
    const renameStatements = compilePostgresqlRenameStatements(
      currentTables,
      options.renames ?? [],
    );
    const statements = [
      ...namespaceStatements,
      ...renameStatements,
      ...compilePostgresqlTableDiffStatements(desiredTables, currentTables),
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

export async function migratePostgresql(
  options: MigrationRunOptions,
): Promise<MigrationResult> {
  if (options.dryRun && !options.url) {
    const plan = await planPostgresqlMigration(options);
    const statements = [
      compilePostgresqlHistoryTable(options.historyTable),
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
    throw new NPAMigrationError("PostgreSQL migration requires a database url.", {
      code: "NPA_MIGRATION_DATABASE_URL_REQUIRED",
    });
  }

  const connection = new PostgresqlConnection(await createPool(options.url));

  try {
    if (options.dryRun) {
      const plan = await planPostgresqlMigration(options);
      const statements = [
        compilePostgresqlHistoryTable(options.historyTable),
        ...plan.statements,
        compileHistoryUpsertPreview(
          options.historyTable,
          options.checksum,
          plan.statementCount,
        ),
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

    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await ensurePostgresqlHistoryTable(connection, options.historyTable);
    await connection.query("BEGIN");

    let statementCount = 0;
    try {
      const previousChecksum = await readPreviousChecksum(connection, options.historyTable);

      if (previousChecksum === options.checksum) {
        await connection.query("COMMIT");
        return {
          status: "noop",
          checksum: options.checksum,
          previousChecksum,
          statements: [],
          statementCount: 0,
        };
      }

      const namespaceStatements = compilePostgresqlNamespaceStatements(options.entities);

      for (const statement of namespaceStatements) {
        await connection.query(statement);
      }

      const desiredTables = buildDesiredTables(options.entities);
      const currentTables = await readCurrentTables(
        connection,
        migrationReadTables(desiredTables, options.renames),
      );
      const renameStatements = compilePostgresqlRenameStatements(
        currentTables,
        options.renames ?? [],
      );
      const tableStatements = [
        ...renameStatements,
        ...compilePostgresqlTableDiffStatements(desiredTables, currentTables),
      ];
      const migrationStatements = [...namespaceStatements, ...tableStatements];
      statementCount = migrationStatements.length;

      assertSafeMigrationStatements(tableStatements, options);

      for (const statement of tableStatements) {
        await connection.query(statement);
      }

      await upsertHistory(connection, options, statementCount, "applied");
      await connection.query("COMMIT");

      return {
        status: "applied",
        checksum: options.checksum,
        previousChecksum,
        statements: migrationStatements,
        statementCount: migrationStatements.length,
      };
    } catch (error) {
      await Promise.resolve(connection.query("ROLLBACK")).catch(() => undefined);
      await recordHistoryFailure(connection, options, MIGRATION_NAME, options.checksum, statementCount, error);
      throw error;
    }
  } finally {
    await Promise.resolve(
      connection.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]),
    ).catch(() => undefined);
    await connection.close();
  }
}

export async function deployPostgresqlMigrations(
  options: MigrationDeployOptions,
): Promise<MigrationDeployResult> {
  if (!options.url) {
    throw new NPAMigrationError("PostgreSQL migration deploy requires a database url.", {
      code: "NPA_MIGRATION_DATABASE_URL_REQUIRED",
    });
  }

  const connection = new PostgresqlConnection(await createPool(options.url));

  try {
    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await ensurePostgresqlHistoryTable(connection, options.historyTable);
    await connection.query("BEGIN");

    let activeMigration: MigrationFile | undefined;
    try {
      await assertNoPostgresqlHistoryDrift(connection, options);
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

      await connection.query("COMMIT");

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
      await Promise.resolve(connection.query("ROLLBACK")).catch(() => undefined);
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
    await Promise.resolve(
      connection.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]),
    ).catch(() => undefined);
    await connection.close();
  }
}

function compilePostgresqlNamespaceStatements(
  entities: MigrationEntitySchema[],
): string[] {
  const schemas = new Set(
    buildDesiredTables(entities)
      .map((table) => table.schema)
      .filter((schema): schema is string => !!schema),
  );

  return [...schemas]
    .sort()
    .map((schema) => `CREATE SCHEMA IF NOT EXISTS ${quoteQualifiedIdentifier(schema)}`);
}

function compilePostgresqlTableDiffStatements(
  desiredTables: MigrationTableSchema[],
  currentTables: Map<string, CurrentTableSchema>,
): string[] {
  const statements: string[] = [];
  const foreignKeyStatements: string[] = [];

  for (const table of desiredTables) {
    const currentTable = currentTables.get(tableKey(table));

    if (!currentTable?.exists) {
      statements.push(...compilePostgresqlCreateTableStatements(table));
      foreignKeyStatements.push(
        ...compilePostgresqlForeignKeyDiffStatements(table, new Map()),
      );
      continue;
    }

    for (const column of table.columns) {
      const currentColumn = currentTable.columns.get(column.columnName);

      if (!currentColumn) {
        statements.push(
          ...compilePostgresqlEnumTypeStatements({ ...table, columns: [column] }),
          ...compilePostgresqlColumnSequenceStatements(table, column),
          `ALTER TABLE ${qualifiedTable(table)} ADD COLUMN ${quoteQualifiedIdentifier(column.columnName)} ${columnDefinition(column, { inlinePrimary: column.primary, table })}`,
        );
        continue;
      }

      const expectedType = normalizePostgresqlTypeName(columnAlterType(table, column));
      const currentType = normalizePostgresqlTypeName(currentColumn.type);

      if (currentType !== expectedType) {
        const renderedType = columnAlterType(table, column);
        statements.push(
          ...compilePostgresqlEnumTypeStatements({ ...table, columns: [column] }),
          `ALTER TABLE ${qualifiedTable(table)} ALTER COLUMN ${quoteQualifiedIdentifier(column.columnName)} TYPE ${renderedType} USING ${quoteQualifiedIdentifier(column.columnName)}::${renderedType}`,
        );
      }

      if (!column.primary && currentColumn.nullable !== column.nullable) {
        statements.push(
          `ALTER TABLE ${qualifiedTable(table)} ALTER COLUMN ${quoteQualifiedIdentifier(column.columnName)} ${column.nullable ? "DROP" : "SET"} NOT NULL`,
        );
      }

      if (!column.primary) {
        const defaultStatement = postgresqlDefaultDiffStatement(
          table,
          column,
          currentColumn,
        );

        if (defaultStatement) {
          statements.push(defaultStatement);
        }
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

    statements.push(...compilePostgresqlIndexDiffStatements(table, currentTable.indexes));
    statements.push(
      ...compilePostgresqlCheckConstraintDiffStatements(
        table,
        currentTable.checkConstraints,
      ),
    );
    foreignKeyStatements.push(
      ...compilePostgresqlForeignKeyDiffStatements(table, currentTable.foreignKeys),
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

function compilePostgresqlRenameStatements(
  currentTables: Map<string, CurrentTableSchema>,
  renames: MigrationRename[],
): string[] {
  const statements: string[] = [];

  for (const rename of renames) {
    if (rename.kind === "table") {
      if ((rename.from.schema ?? "public") !== (rename.to.schema ?? "public")) {
        throw new NPAMigrationError("PostgreSQL table renames cannot move tables between schemas.", {
          code: "NPA_MIGRATION_INVALID_RENAME",
        });
      }

      const fromKey = tableKey(rename.from);
      const toKey = tableKey(rename.to);
      const fromTable = currentTables.get(fromKey);
      const toTable = currentTables.get(toKey);

      if (fromTable?.exists && !toTable?.exists) {
        statements.push(
          `ALTER TABLE ${qualifiedTable(rename.from)} RENAME TO ${quoteQualifiedIdentifier(rename.to.tableName)}`,
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

function compilePostgresqlCreateTableStatements(table: MigrationTableSchema): string[] {
  return [
    ...compilePostgresqlEnumTypeStatements(table),
    ...compilePostgresqlSequenceStatements(table),
    compilePostgresqlCreateTable(table),
    ...table.indexes.map((index) => compilePostgresqlCreateIndex(table, index)),
  ];
}

function compilePostgresqlSequenceStatements(table: MigrationTableSchema): string[] {
  return table.columns.flatMap((column) =>
    compilePostgresqlColumnSequenceStatements(table, column),
  );
}

function compilePostgresqlColumnSequenceStatements(
  table: MigrationTableSchema,
  column: MigrationColumnSchema,
): string[] {
  return column.primary && column.generationStrategy === "SEQUENCE"
    ? [`CREATE SEQUENCE IF NOT EXISTS ${postgresqlSequenceName(table, column)}`]
    : [];
}

function compilePostgresqlForeignKeyDiffStatements(
  table: MigrationTableSchema,
  currentForeignKeys: Map<string, CurrentForeignKeySchema>,
): string[] {
  const statements: string[] = [];

  for (const foreignKey of [...table.foreignKeys].sort(compareByName)) {
    if (currentForeignKeys.has(foreignKey.name)) {
      continue;
    }

    statements.push(
      `ALTER TABLE ${qualifiedTable(table)} ADD ${compilePostgresqlForeignKeyConstraint(foreignKey)}`,
    );
  }

  return statements;
}

function compilePostgresqlIndexDiffStatements(
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
      statements.push(compilePostgresqlCreateIndex(table, index));
      continue;
    }

    if (
      currentIndex.primary ||
      currentIndex.unique !== index.unique ||
      currentIndex.columns.join(",") !== index.columns.join(",")
    ) {
      statements.push(`DROP INDEX IF EXISTS ${qualifiedIndex(table, indexName)}`);
      statements.push(compilePostgresqlCreateIndex(table, index));
    }
  }

  for (const currentIndex of [...currentIndexes.values()].sort(compareByName)) {
    if (!currentIndex.primary && !desiredIndexNames.has(currentIndex.name)) {
      statements.push(`DROP INDEX IF EXISTS ${qualifiedIndex(table, currentIndex.name)}`);
    }
  }

  return statements;
}

function compilePostgresqlCheckConstraintDiffStatements(
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
        `ALTER TABLE ${qualifiedTable(table)} DROP CONSTRAINT ${quoteQualifiedIdentifier(current.name)}`,
      );
    }
  }

  for (const check of desiredChecks) {
    if (!currentChecks.has(check.name)) {
      statements.push(
        `ALTER TABLE ${qualifiedTable(table)} ADD ${compilePostgresqlCheckConstraint(check)}`,
      );
    }
  }

  return statements;
}

function compilePostgresqlCreateTable(table: MigrationTableSchema): string {
  const columnLines = table.columns.map(
    (column) => `  ${quoteQualifiedIdentifier(column.columnName)} ${columnDefinition(column, { inlinePrimary: !table.primaryKey, table })}`,
  );
  const primaryKeyLines = table.primaryKey?.length
    ? [`  PRIMARY KEY (${table.primaryKey.map(quoteQualifiedIdentifier).join(", ")})`]
    : [];
  const checkLines = desiredEnumCheckConstraints(table).map(
    (check) => `  ${compilePostgresqlCheckConstraint(check)}`,
  );

  return [
    `CREATE TABLE IF NOT EXISTS ${qualifiedTable(table)} (`,
    [...columnLines, ...primaryKeyLines, ...checkLines].join(",\n"),
    ")",
  ].join("\n");
}

function compilePostgresqlForeignKeyConstraint(
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

function compilePostgresqlCheckConstraint(
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

function compilePostgresqlEnumTypeStatements(table: MigrationTableSchema): string[] {
  const statements = new Map<string, string>();

  for (const column of table.columns) {
    if (!isNativeEnumColumn(column)) {
      continue;
    }

    const typeName = postgresqlEnumTypeName(table, column);
    statements.set(typeName, [
      "DO $$ BEGIN",
      `  CREATE TYPE ${typeName} AS ENUM (${enumSqlLiterals(column.enumValues ?? [])});`,
      "EXCEPTION WHEN duplicate_object THEN NULL;",
      "END $$",
    ].join("\n"));
  }

  return [...statements.values()];
}

function isNativeEnumColumn(column: MigrationColumnSchema): boolean {
  return !!column.enumValues?.length && column.enumType === "NATIVE";
}

function isOrdinalEnumColumn(column: MigrationColumnSchema): boolean {
  return !!column.enumValues?.length && column.enumType === "ORDINAL";
}

function enumCheckLiterals(column: MigrationColumnSchema): string {
  if (isOrdinalEnumColumn(column)) {
    return (column.enumValues ?? []).map((_, index) => String(index)).join(", ");
  }

  return enumSqlLiterals(column.enumValues ?? []);
}

function postgresqlEnumTypeName(
  table: MigrationTableSchema | undefined,
  column: MigrationColumnSchema,
): string {
  if (column.enumName) {
    return quoteQualifiedIdentifier(column.enumName);
  }

  const name = sanitizeIdentifier(`${table?.tableName ?? "npa"}_${column.columnName}_enum`);
  return table?.schema
    ? `${quoteQualifiedIdentifier(table.schema)}.${quoteQualifiedIdentifier(name)}`
    : quoteQualifiedIdentifier(name);
}

function enumSqlLiterals(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
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
  options: { inlinePrimary: boolean; table?: MigrationTableSchema },
): string {
  const dbType = columnType(column, {
    identity: options.inlinePrimary,
    table: options.table,
  });
  const constraints = options.inlinePrimary && column.primary
    ? " PRIMARY KEY"
    : column.nullable
      ? ""
      : " NOT NULL";
  const defaultClause = columnDefaultClause(column, options.table);

  return `${dbType}${constraints}${defaultClause}`;
}

function columnAlterType(table: MigrationTableSchema, column: MigrationColumnSchema): string {
  return columnType(column, { identity: false, table });
}

function columnType(
  column: MigrationColumnSchema,
  options: { identity: boolean; table?: MigrationTableSchema },
): string {
  if (isNativeEnumColumn(column)) {
    return postgresqlEnumTypeName(options.table, column);
  }

  return column.dbType ?? defaultType(column, { identity: options.identity });
}

function postgresqlDefaultDiffStatement(
  table: MigrationTableSchema,
  column: MigrationColumnSchema,
  currentColumn: CurrentColumnSchema,
): string | undefined {
  const expectedDefault = normalizeDesiredDefault(column);
  const currentDefault = normalizePostgresqlDefault(currentColumn.defaultValue);

  if (expectedDefault === currentDefault) {
    return undefined;
  }

  const columnName = quoteQualifiedIdentifier(column.columnName);

  if (expectedDefault === undefined) {
    return `ALTER TABLE ${qualifiedTable(table)} ALTER COLUMN ${columnName} DROP DEFAULT`;
  }

  return `ALTER TABLE ${qualifiedTable(table)} ALTER COLUMN ${columnName} SET DEFAULT ${renderColumnDefault(column)}`;
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

function normalizePostgresqlDefault(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  const lowercase = normalized.toLowerCase();

  if (
    lowercase === "now()" ||
    /^current_timestamp(?:\(\d+\))?$/.test(lowercase)
  ) {
    return "raw:current_timestamp";
  }

  if (normalized === "true" || normalized === "false") {
    return `boolean:${normalized === "true"}`;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return `number:${Number(normalized)}`;
  }

  const stringMatch = /^'((?:''|[^'])*)'(?:::.+)?$/.exec(normalized);

  if (stringMatch) {
    return `string:${stringMatch[1].replace(/''/g, "'")}`;
  }

  return `raw:${normalized}`;
}

function columnDefaultClause(
  column: MigrationColumnSchema,
  table?: MigrationTableSchema,
): string {
  if (column.primary && column.generationStrategy === "UUID") {
    return " DEFAULT gen_random_uuid()";
  }

  if (column.primary && column.generationStrategy === "SEQUENCE") {
    return ` DEFAULT nextval('${postgresqlSequenceName(table, column, { literal: true })}')`;
  }

  if (column.defaultCurrentTimestamp) {
    return " DEFAULT CURRENT_TIMESTAMP";
  }

  if (column.defaultValue === undefined) {
    return "";
  }

  return ` DEFAULT ${renderColumnDefault(column)}`;
}

function renderColumnDefault(column: MigrationColumnSchema): string {
  if (column.defaultCurrentTimestamp) {
    return "CURRENT_TIMESTAMP";
  }

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
    return "SERIAL";
  }

  if (column.primary && column.generationStrategy === "UUID") {
    return "UUID";
  }

  if (column.array || arrayElementType) {
    return `${postgresqlArrayElementType(column, arrayElementType)}[]`;
  }

  if (normalized === "string") {
    return "TEXT";
  }

  if (column.enumValues?.length) {
    return isOrdinalEnumColumn(column) ? "INTEGER" : "TEXT";
  }

  if (normalized === "number") {
    return "INTEGER";
  }

  if (["bigint", "biginteger"].includes(normalized.toLowerCase())) {
    return "BIGINT";
  }

  if (normalized === "boolean") {
    return "BOOLEAN";
  }

  if (normalized === "Date") {
    return "TIMESTAMPTZ";
  }

  throw new NPAMigrationError(
    `Unsupported PostgreSQL migration type "${column.tsType}" for ${column.propertyName}. Use @Column({ type: "..." }).`,
    {
      code: "NPA_MIGRATION_UNSUPPORTED_DDL",
      details: { propertyName: column.propertyName, tsType: column.tsType },
    },
  );
}

function postgresqlArrayElementType(
  column: MigrationColumnSchema,
  arrayElementType: string | undefined,
): string {
  const normalized = normalizeType(arrayElementType ?? column.tsType);

  if (normalized === "string") {
    return "TEXT";
  }

  if (normalized === "number") {
    return "INTEGER";
  }

  if (["bigint", "biginteger"].includes(normalized.toLowerCase())) {
    return "BIGINT";
  }

  if (normalized === "boolean") {
    return "BOOLEAN";
  }

  if (normalized === "Date") {
    return "TIMESTAMPTZ";
  }

  throw new NPAMigrationError(
    `Unsupported PostgreSQL array element type "${arrayElementType ?? column.tsType}" for ${column.propertyName}. Use @Column({ type: "..." }).`,
    {
      code: "NPA_MIGRATION_UNSUPPORTED_DDL",
      details: {
        propertyName: column.propertyName,
        tsType: column.tsType,
        arrayElementType: arrayElementType ?? column.tsType,
      },
    },
  );
}

function postgresqlSequenceName(
  table: MigrationTableSchema | undefined,
  column: MigrationColumnSchema,
  options: { literal?: boolean } = {},
): string {
  const name =
    column.sequenceName ??
    `${table?.tableName ?? "npa"}_${column.columnName}_seq`;
  const qualified =
    table?.schema && !name.includes(".")
      ? `${quoteQualifiedIdentifier(table.schema)}.${quoteQualifiedIdentifier(name)}`
      : quoteQualifiedIdentifier(name);

  return options.literal ? qualified.replace(/'/g, "''") : qualified;
}

function buildDesiredTables(entities: MigrationEntitySchema[]): MigrationTableSchema[] {
  return buildDesiredMigrationTables(entities, {
    defaultColumnType: (column) => defaultType(column, { identity: false }),
    foreignKeyIdentifierMaxLength: MAX_FOREIGN_KEY_IDENTIFIER_LENGTH,
  });
}

async function readCurrentTables(
  connection: PostgresqlConnection,
  desiredTables: MigrationTableSchema[],
): Promise<Map<string, CurrentTableSchema>> {
  const currentTables = new Map<string, CurrentTableSchema>();

  for (const table of desiredTables) {
    const result = await connection.query<PostgresqlColumnRow>(
      [
        "SELECT",
        "  column_name AS \"columnName\",",
        "  data_type AS \"dataType\",",
        "  udt_name AS \"udtName\",",
        "  character_maximum_length AS \"characterMaximumLength\",",
        "  column_default AS \"columnDefault\",",
        "  is_nullable AS \"isNullable\"",
        "FROM information_schema.columns",
        "WHERE table_schema = $1 AND table_name = $2",
        "ORDER BY ordinal_position",
      ].join("\n"),
      [table.schema ?? "public", table.tableName],
    );
    const columns = new Map<string, CurrentColumnSchema>();

    for (const row of result.rows) {
      columns.set(row.columnName, {
        columnName: row.columnName,
        type: currentPostgresqlType(row),
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

function currentPostgresqlType(row: PostgresqlColumnRow): string {
  if (row.dataType === "USER-DEFINED") {
    return row.udtName;
  }

  if (row.dataType === "ARRAY") {
    return `${postgresqlArrayElementTypeFromUdt(row.udtName)}[]`;
  }

  if (row.dataType === "character varying" && row.characterMaximumLength) {
    return `character varying(${row.characterMaximumLength})`;
  }

  return row.dataType;
}

function postgresqlArrayElementTypeFromUdt(udtName: string): string {
  return normalizePostgresqlTypeName(udtName.replace(/^_/, ""));
}


async function readCurrentIndexes(
  connection: PostgresqlConnection,
  table: MigrationTableSchema,
): Promise<Map<string, CurrentIndexSchema>> {
  const result = await connection.query<PostgresqlIndexRow>(
    [
      "SELECT",
      "  i.relname AS \"indexName\",",
      "  string_agg(a.attname, E'\\x1f' ORDER BY keys.ordinality) AS \"columns\",",
      "  ix.indisunique AS \"unique\",",
      "  ix.indisprimary AS \"primary\"",
      "FROM pg_class t",
      "JOIN pg_namespace n ON n.oid = t.relnamespace",
      "JOIN pg_index ix ON ix.indrelid = t.oid",
      "JOIN pg_class i ON i.oid = ix.indexrelid",
      "JOIN unnest(ix.indkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true",
      "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keys.attnum",
      "WHERE n.nspname = $1 AND t.relname = $2",
      "GROUP BY i.relname, ix.indisunique, ix.indisprimary",
    ].join("\n"),
    [table.schema ?? "public", table.tableName],
  );
  const indexes = new Map<string, CurrentIndexSchema>();

  for (const row of result.rows) {
    indexes.set(row.indexName, {
      name: row.indexName,
      columns: normalizePostgresqlIndexColumns(row.columns),
      unique: row.unique,
      primary: row.primary,
    });
  }

  return indexes;
}

function normalizePostgresqlIndexColumns(columns: string[] | string): string[] {
  return Array.isArray(columns)
    ? columns
    : columns.split(INDEX_COLUMN_SEPARATOR).filter(Boolean);
}

async function readCurrentForeignKeys(
  connection: PostgresqlConnection,
  table: MigrationTableSchema,
): Promise<Map<string, CurrentForeignKeySchema>> {
  const result = await connection.query<PostgresqlForeignKeyRow>(
    [
      "SELECT",
      "  tc.constraint_name AS \"constraintName\",",
      "  array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS \"columns\",",
      "  ccu.table_schema AS \"referencedSchema\",",
      "  ccu.table_name AS \"referencedTable\",",
      "  array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS \"referencedColumns\"",
      "FROM information_schema.table_constraints tc",
      "JOIN information_schema.key_column_usage kcu",
      "  ON tc.constraint_schema = kcu.constraint_schema",
      " AND tc.constraint_name = kcu.constraint_name",
      "JOIN information_schema.constraint_column_usage ccu",
      "  ON tc.constraint_schema = ccu.constraint_schema",
      " AND tc.constraint_name = ccu.constraint_name",
      "WHERE tc.constraint_type = 'FOREIGN KEY'",
      "  AND tc.table_schema = $1",
      "  AND tc.table_name = $2",
      "GROUP BY tc.constraint_name, ccu.table_schema, ccu.table_name",
    ].join("\n"),
    [table.schema ?? "public", table.tableName],
  );
  const foreignKeys = new Map<string, CurrentForeignKeySchema>();

  for (const row of result.rows) {
    foreignKeys.set(row.constraintName, {
      name: row.constraintName,
      columns: row.columns,
      referencedSchema: row.referencedSchema,
      referencedTable: row.referencedTable,
      referencedColumns: row.referencedColumns,
    });
  }

  return foreignKeys;
}

async function readCurrentCheckConstraints(
  connection: PostgresqlConnection,
  table: MigrationTableSchema,
): Promise<Map<string, CurrentCheckConstraintSchema>> {
  const result = await connection.query<PostgresqlCheckConstraintRow>(
    [
      "SELECT",
      "  constraint_name AS \"constraintName\"",
      "FROM information_schema.table_constraints",
      "WHERE constraint_type = 'CHECK'",
      "  AND table_schema = $1",
      "  AND table_name = $2",
    ].join("\n"),
    [table.schema ?? "public", table.tableName],
  );
  const constraints = new Map<string, CurrentCheckConstraintSchema>();

  for (const row of result.rows) {
    constraints.set(row.constraintName, { name: row.constraintName });
  }

  return constraints;
}

async function readPreviousChecksum(
  connection: PostgresqlConnection,
  historyTable: string,
): Promise<string | undefined> {
  const result = await readHistoryRecord(connection, historyTable, MIGRATION_NAME);

  return result?.checksum;
}

async function readHistoryRecord(
  connection: PostgresqlConnection,
  historyTable: string,
  name: string,
): Promise<PostgresqlHistoryRow | undefined> {
  const result = await connection.query<PostgresqlHistoryRow>(
    `SELECT name, checksum FROM ${quoteQualifiedIdentifier(historyTable)} WHERE name = $1 AND status = 'applied' LIMIT 1`,
    [name],
  );

  return result.rows[0];
}

async function readHistoryRecords(
  connection: PostgresqlConnection,
  historyTable: string,
): Promise<PostgresqlHistoryRow[]> {
  const result = await connection.query<PostgresqlHistoryRow>(
    `SELECT name, checksum FROM ${quoteQualifiedIdentifier(historyTable)} WHERE status = 'applied' ORDER BY name`,
  );

  return result.rows;
}

async function assertNoPostgresqlHistoryDrift(
  connection: PostgresqlConnection,
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
  connection: PostgresqlConnection,
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
  connection: PostgresqlConnection,
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

async function ensurePostgresqlHistoryTable(
  connection: PostgresqlConnection,
  historyTable: string,
): Promise<void> {
  await ensurePostgresqlHistorySchema(connection, historyTable);
  await connection.query(compilePostgresqlHistoryTable(historyTable));
  await connection.query(
    `ALTER TABLE ${quoteQualifiedIdentifier(historyTable)} ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied'`,
  );
  await connection.query(
    `ALTER TABLE ${quoteQualifiedIdentifier(historyTable)} ADD COLUMN IF NOT EXISTS error_message TEXT`,
  );
}

async function ensurePostgresqlHistorySchema(
  connection: PostgresqlConnection,
  historyTable: string,
): Promise<void> {
  const schema = historyTable.split(".").at(-2);

  if (schema) {
    await connection.query(
      `CREATE SCHEMA IF NOT EXISTS ${quoteQualifiedIdentifier(unquotePostgresqlIdentifier(schema))}`,
    );
  }
}

async function recordHistoryFailure(
  connection: PostgresqlConnection,
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
  connection: PostgresqlConnection,
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
      "VALUES ($1, $2, $3, $4, $5, $6)",
      "ON CONFLICT (name) DO UPDATE SET",
      "  checksum = EXCLUDED.checksum,",
      "  adapter = EXCLUDED.adapter,",
      "  applied_at = NOW(),",
      "  statement_count = EXCLUDED.statement_count,",
      "  status = EXCLUDED.status,",
      "  error_message = EXCLUDED.error_message",
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

async function createPool(url: string): Promise<PostgresqlDriverConnection> {
  const pg = await importDriver<{
    Pool: new (options: { connectionString: string }) => PostgresqlDriverConnection;
  }>("pg");

  return new pg.Pool({ connectionString: url });
}

function compileHistoryUpsertPreview(
  historyTable: string,
  checksum: string,
  statementCount: number,
): string {
  return [
    `INSERT INTO ${quoteQualifiedIdentifier(historyTable)} (name, checksum, adapter, statement_count, status, error_message) VALUES ('${MIGRATION_NAME}', '${checksum}', 'postgresql', ${statementCount}, 'applied', NULL)`,
    "ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, adapter = EXCLUDED.adapter, applied_at = NOW(), statement_count = EXCLUDED.statement_count, status = EXCLUDED.status, error_message = EXCLUDED.error_message",
  ].join("\n");
}

function toHistoryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

function compilePostgresqlCreateIndex(
  table: MigrationTableSchema,
  index: MigrationIndexSchema,
): string {
  const unique = index.unique ? "UNIQUE " : "";

  return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteQualifiedIdentifier(resolveIndexName(table, index))} ON ${qualifiedTable(table)} (${index.columns.map(quoteQualifiedIdentifier).join(", ")})`;
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

function qualifiedIndex(table: Pick<MigrationTableSchema, "schema">, indexName: string): string {
  const index = quoteQualifiedIdentifier(indexName);

  return table.schema ? `${quoteQualifiedIdentifier(table.schema)}.${index}` : index;
}

function qualifiedTable(table: Pick<MigrationTableSchema, "schema" | "tableName">): string {
  const quotedTable = quoteQualifiedIdentifier(table.tableName);

  return table.schema ? `${quoteQualifiedIdentifier(table.schema)}.${quotedTable}` : quotedTable;
}

function normalizePostgresqlTypeName(value: string): string {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();

  if (normalized.endsWith("[]")) {
    return `${normalizePostgresqlTypeName(normalized.slice(0, -2))}[]`;
  }

  const varcharMatch = /^varchar\((\d+)\)$/.exec(normalized);

  if (varcharMatch) {
    return `character varying(${varcharMatch[1]})`;
  }

  if (normalized === "varchar") {
    return "character varying";
  }

  if (normalized === "int" || normalized === "int4" || normalized === "serial") {
    return "integer";
  }

  if (normalized === "bool") {
    return "boolean";
  }

  if (normalized === "timestamptz") {
    return "timestamp with time zone";
  }

  if (normalized === "timestamp") {
    return "timestamp without time zone";
  }

  const unquoted = normalized.replace(/"/g, "");
  if (/^[a-z_]\w*(?:\.[a-z_]\w*)?$/.test(unquoted)) {
    return unquoted.split(".").at(-1) ?? unquoted;
  }

  return normalized;
}

function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new NPADatabaseError("PostgreSQL identifier must not be empty.", {
      code: "NPA_DATABASE_IDENTIFIER_INVALID",
    });
  }

  return `"${identifier.replace(/"/g, '""')}"`;
}

function unquotePostgresqlIdentifier(identifier: string): string {
  return identifier.replace(/^"|"$/g, "").replace(/""/g, '"');
}
