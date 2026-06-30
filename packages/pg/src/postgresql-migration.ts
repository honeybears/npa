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
import { PostgresqlConnection, PostgresqlDriverConnection } from "./postgresql-connection";

const MIGRATION_NAME = "schema";
const LOCK_KEY = "npa:migrations";

interface MigrationTableSchema {
  tableName: string;
  schema?: string;
  columns: NPAMigrationColumnSchema[];
  indexes: NPAMigrationIndexSchema[];
  primaryKey?: string[];
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

interface CurrentTableSchema {
  exists: boolean;
  columns: Map<string, CurrentColumnSchema>;
  indexes: Map<string, CurrentIndexSchema>;
}

interface PostgresqlColumnRow {
  columnName: string;
  dataType: string;
  characterMaximumLength: number | null;
  isNullable: "YES" | "NO";
}

interface PostgresqlIndexRow {
  indexName: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

interface PostgresqlHistoryRow {
  checksum: string;
}

export interface PostgresqlMigrationCompileOptions {
  entities: NPAMigrationEntitySchema[];
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
  entities: NPAMigrationEntitySchema[],
): string[] {
  return [
    ...compilePostgresqlNamespaceStatements(entities),
    ...buildDesiredTables(entities).flatMap((table) => compilePostgresqlCreateTableStatements(table)),
  ];
}

export function compilePostgresqlHistoryTable(historyTable: string): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${quoteQualifiedIdentifier(historyTable)} (`,
    "  name TEXT PRIMARY KEY,",
    "  checksum TEXT NOT NULL,",
    "  adapter TEXT NOT NULL,",
    "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "  statement_count INTEGER NOT NULL",
    ")",
  ].join("\n");
}

export async function planPostgresqlMigration(
  options: NPAMigrationRunOptions,
): Promise<NPAMigrationResult> {
  if (!options.url) {
    const statements = compilePostgresqlSchemaStatements(options.entities);

    return {
      status: "dry-run",
      checksum: options.checksum,
      statements,
      statementCount: statements.length,
    };
  }

  const connection = new PostgresqlConnection(await createPool(options.url));

  try {
    const namespaceStatements = compilePostgresqlNamespaceStatements(options.entities);
    const desiredTables = buildDesiredTables(options.entities);
    const currentTables = await readCurrentTables(connection, desiredTables);
    const statements = [
      ...namespaceStatements,
      ...compilePostgresqlTableDiffStatements(desiredTables, currentTables),
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

export async function migratePostgresql(
  options: NPAMigrationRunOptions,
): Promise<NPAMigrationResult> {
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
    };
  }

  if (!options.url) {
    throw new Error("PostgreSQL migration requires a database url.");
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
      };
    }

    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await connection.query("BEGIN");

    try {
      await connection.query(compilePostgresqlHistoryTable(options.historyTable));
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
      const currentTables = await readCurrentTables(connection, desiredTables);
      const tableStatements = compilePostgresqlTableDiffStatements(desiredTables, currentTables);
      const migrationStatements = [...namespaceStatements, ...tableStatements];

      for (const statement of tableStatements) {
        await connection.query(statement);
      }

      await upsertHistory(connection, options, migrationStatements.length);
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
  options: NPAMigrationDeployOptions,
): Promise<NPAMigrationDeployResult> {
  if (!options.url) {
    throw new Error("PostgreSQL migration deploy requires a database url.");
  }

  const connection = new PostgresqlConnection(await createPool(options.url));

  try {
    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await connection.query("BEGIN");

    try {
      await connection.query(compilePostgresqlHistoryTable(options.historyTable));
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
  entities: NPAMigrationEntitySchema[],
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

  for (const table of desiredTables) {
    const currentTable = currentTables.get(tableKey(table));

    if (!currentTable?.exists) {
      statements.push(...compilePostgresqlCreateTableStatements(table));
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

      const expectedType = normalizePostgresqlTypeName(columnAlterType(column));
      const currentType = normalizePostgresqlTypeName(currentColumn.type);

      if (currentType !== expectedType) {
        const renderedType = columnAlterType(column);
        statements.push(
          `ALTER TABLE ${qualifiedTable(table)} ALTER COLUMN ${quoteQualifiedIdentifier(column.columnName)} TYPE ${renderedType} USING ${quoteQualifiedIdentifier(column.columnName)}::${renderedType}`,
        );
      }

      if (!column.primary && currentColumn.nullable !== column.nullable) {
        statements.push(
          `ALTER TABLE ${qualifiedTable(table)} ALTER COLUMN ${quoteQualifiedIdentifier(column.columnName)} ${column.nullable ? "DROP" : "SET"} NOT NULL`,
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

    statements.push(...compilePostgresqlIndexDiffStatements(table, currentTable.indexes));
  }

  return statements;
}

function compilePostgresqlCreateTableStatements(table: MigrationTableSchema): string[] {
  return [
    compilePostgresqlCreateTable(table),
    ...table.indexes.map((index) => compilePostgresqlCreateIndex(table, index)),
  ];
}

function compilePostgresqlIndexDiffStatements(
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

  for (const currentIndex of [...currentIndexes.values()].sort(compareCurrentIndexes)) {
    if (!currentIndex.primary && !desiredIndexNames.has(currentIndex.name)) {
      statements.push(`DROP INDEX IF EXISTS ${qualifiedIndex(table, currentIndex.name)}`);
    }
  }

  return statements;
}

function compilePostgresqlCreateTable(table: MigrationTableSchema): string {
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
    return "SERIAL";
  }

  if (normalized === "string") {
    return "TEXT";
  }

  if (normalized === "number") {
    return "INTEGER";
  }

  if (normalized === "boolean") {
    return "BOOLEAN";
  }

  if (normalized === "Date") {
    return "TIMESTAMPTZ";
  }

  throw new Error(
    `Unsupported PostgreSQL migration type "${column.tsType}" for ${column.propertyName}. Use @Column({ type: "..." }).`,
  );
}

function buildDesiredTables(entities: NPAMigrationEntitySchema[]): MigrationTableSchema[] {
  const tables = new Map<string, MigrationTableSchema>();
  const sortedEntities = [...entities].sort(compareEntities);

  for (const entity of sortedEntities) {
    const table = entityTable(entity);
    tables.set(tableKey(table), table);
  }

  for (const table of buildJoinTables(sortedEntities)) {
    tables.set(tableKey(table), table);
  }

  return [...tables.values()].sort(compareTables);
}

function entityTable(entity: NPAMigrationEntitySchema): MigrationTableSchema {
  return {
    tableName: entity.tableName,
    schema: entity.schema,
    columns: entity.columns,
    indexes: entity.indexes ?? [],
  };
}

function buildJoinTables(entities: NPAMigrationEntitySchema[]): MigrationTableSchema[] {
  const byClassName = new Map(entities.map((entity) => [entity.className, entity]));
  const tables: MigrationTableSchema[] = [];

  for (const entity of entities) {
    for (const relation of entity.relations ?? []) {
      if (relation.kind !== "many-to-many") {
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
        "  character_maximum_length AS \"characterMaximumLength\",",
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
        nullable: row.isNullable === "YES",
      });
    }

    const indexes = await readCurrentIndexes(connection, table);

    currentTables.set(tableKey(table), {
      exists: columns.size > 0,
      columns,
      indexes,
    });
  }

  return currentTables;
}

function currentPostgresqlType(row: PostgresqlColumnRow): string {
  if (row.dataType === "character varying" && row.characterMaximumLength) {
    return `character varying(${row.characterMaximumLength})`;
  }

  return row.dataType;
}


async function readCurrentIndexes(
  connection: PostgresqlConnection,
  table: MigrationTableSchema,
): Promise<Map<string, CurrentIndexSchema>> {
  const result = await connection.query<PostgresqlIndexRow>(
    [
      "SELECT",
      "  i.relname AS \"indexName\",",
      "  array_agg(a.attname ORDER BY keys.ordinality) AS \"columns\",",
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
      columns: row.columns,
      unique: row.unique,
      primary: row.primary,
    });
  }

  return indexes;
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
    `SELECT checksum FROM ${quoteQualifiedIdentifier(historyTable)} WHERE name = $1 LIMIT 1`,
    [name],
  );

  return result.rows[0];
}

async function upsertHistory(
  connection: PostgresqlConnection,
  options: NPAMigrationRunOptions,
  statementCount: number,
): Promise<void> {
  await connection.query(
    [
      `INSERT INTO ${quoteQualifiedIdentifier(options.historyTable)} (name, checksum, adapter, statement_count)`,
      "VALUES ($1, $2, $3, $4)",
      "ON CONFLICT (name) DO UPDATE SET",
      "  checksum = EXCLUDED.checksum,",
      "  adapter = EXCLUDED.adapter,",
      "  applied_at = NOW(),",
      "  statement_count = EXCLUDED.statement_count",
    ].join("\n"),
    [MIGRATION_NAME, options.checksum, options.adapter, statementCount],
  );
}

async function insertHistory(
  connection: PostgresqlConnection,
  options: NPAMigrationDeployOptions,
  migration: NPAMigrationFile,
): Promise<void> {
  await connection.query(
    [
      `INSERT INTO ${quoteQualifiedIdentifier(options.historyTable)} (name, checksum, adapter, statement_count)`,
      "VALUES ($1, $2, $3, $4)",
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
    `INSERT INTO ${quoteQualifiedIdentifier(historyTable)} (name, checksum, adapter, statement_count) VALUES ('${MIGRATION_NAME}', '${checksum}', 'postgresql', ${statementCount})`,
    "ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, adapter = EXCLUDED.adapter, applied_at = NOW(), statement_count = EXCLUDED.statement_count",
  ].join("\n");
}

function compilePostgresqlCreateIndex(
  table: MigrationTableSchema,
  index: NPAMigrationIndexSchema,
): string {
  const unique = index.unique ? "UNIQUE " : "";

  return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteQualifiedIdentifier(resolveIndexName(table, index))} ON ${qualifiedTable(table)} (${index.columns.map(quoteQualifiedIdentifier).join(", ")})`;
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

function qualifiedIndex(table: Pick<MigrationTableSchema, "schema">, indexName: string): string {
  const index = quoteQualifiedIdentifier(indexName);

  return table.schema ? `${quoteQualifiedIdentifier(table.schema)}.${index}` : index;
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function compareCurrentIndexes(left: CurrentIndexSchema, right: CurrentIndexSchema): number {
  return left.name.localeCompare(right.name);
}

function compareIndexes(left: NPAMigrationIndexSchema, right: NPAMigrationIndexSchema): number {
  return `${left.name ?? ""}.${left.unique ? "unique" : "index"}.${left.columns.join(",")}`.localeCompare(
    `${right.name ?? ""}.${right.unique ? "unique" : "index"}.${right.columns.join(",")}`,
  );
}

function qualifiedTable(table: Pick<MigrationTableSchema, "schema" | "tableName">): string {
  const quotedTable = quoteQualifiedIdentifier(table.tableName);

  return table.schema ? `${quoteQualifiedIdentifier(table.schema)}.${quotedTable}` : quotedTable;
}

function tableKey(table: Pick<MigrationTableSchema, "schema" | "tableName">): string {
  return `${table.schema ?? ""}.${table.tableName}`;
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

function normalizePostgresqlTypeName(value: string): string {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
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

  return normalized;
}

function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new Error("PostgreSQL identifier must not be empty.");
  }

  return `"${identifier.replace(/"/g, '""')}"`;
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
