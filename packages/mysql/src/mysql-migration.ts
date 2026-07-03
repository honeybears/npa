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
} from "@node-persistence-api/core";
import {
  assertSafeMigrationStatements,
  createDownMigrationStatements,
} from "@node-persistence-api/core";
import { MigrationRelationKind } from "@node-persistence-api/core";
import { createHash } from "node:crypto";
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

interface CurrentTableSchema {
  exists: boolean;
  columns: Map<string, CurrentColumnSchema>;
  indexes: Map<string, CurrentIndexSchema>;
  foreignKeys: Map<string, CurrentForeignKeySchema>;
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

interface MysqlHistoryRow {
  name: string;
  checksum: string;
}

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
    "  statement_count INT NOT NULL",
    ")",
  ].join("\n");
}

export async function planMysqlMigration(
  options: MigrationRunOptions,
): Promise<MigrationResult> {
  if (!options.url) {
    if (options.renames?.length) {
      throw new Error("MySQL migration renames require a database url.");
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
        downStatements: plan.downStatements,
        downStatementCount: plan.downStatementCount,
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

    assertSafeMigrationStatements(tableStatements, options);

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
  options: MigrationDeployOptions,
): Promise<MigrationDeployResult> {
  if (!options.url) {
    throw new Error("MySQL migration deploy requires a database url.");
  }

  const connection = new MysqlConnection(await createPool(options.url));

  try {
    await acquireLock(connection);
    await connection.query(compileMysqlHistoryTable(options.historyTable));
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

      assertSafeMigrationStatements(migration.statements, options);

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

  return [...tables.values()].sort(compareTables);
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
  column: MigrationColumnSchema,
  options: { inlinePrimary: boolean },
): string {
  if (column.primary && column.generationStrategy === "SEQUENCE") {
    throw new Error("MySQL does not support GenerationStrategy.SEQUENCE.");
  }

  const dbType = column.dbType ?? defaultType(column, { identity: options.inlinePrimary });
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
  return column.dbType ?? defaultType(column, { identity: false });
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

function buildDesiredTables(entities: MigrationEntitySchema[]): MigrationTableSchema[] {
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
      throw new Error(
        `@${relation.kind === MigrationRelationKind.ONE_TO_ONE ? "OneToOne" : "ManyToOne"} for ${entity.className}.${relation.propertyName} targets unknown entity ${relation.targetClassName}.`,
      );
    }

    const targetPrimaryColumns = primaryColumns(target);
    const joinColumns = relationJoinColumnNames(relation, targetPrimaryColumns);

    for (const [index, joinColumn] of joinColumns.entries()) {
      const column = {
        ...relationColumn(targetPrimaryColumns[index], joinColumn),
        nullable: true,
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
      name: relation.foreignKeyName ?? foreignKeyName(entity.tableName, joinColumns, target.tableName),
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
        throw new Error(
          `@ManyToMany for ${entity.className}.${relation.propertyName} targets unknown entity ${relation.targetClassName}.`,
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
            name: foreignKeyName(joinTable.tableName, sourceColumnNames, entity.tableName),
            columns: sourceColumnNames,
            referencedSchema: entity.schema,
            referencedTable: entity.tableName,
            referencedColumns: sourcePrimaryColumns.map((column) => column.columnName),
          },
          {
            name: foreignKeyName(joinTable.tableName, targetColumnNames, target.tableName),
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
    throw new Error(
      `@${relation.kind === MigrationRelationKind.ONE_TO_ONE ? "OneToOne" : "ManyToOne"} ${relation.propertyName} defines ${explicit.length} join column(s), but target has ${targetPrimaryColumns.length} @Id column(s).`,
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

function primaryColumn(entity: MigrationEntitySchema): MigrationColumnSchema {
  return primaryColumns(entity)[0];
}

function primaryColumns(entity: MigrationEntitySchema): MigrationColumnSchema[] {
  const primary = entity.columns.filter((column) => column.primary);

  if (primary.length === 0) {
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
      `SELECT name, checksum FROM ${quoteQualifiedIdentifier(historyTable)} WHERE name = ? LIMIT 1`,
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
      `SELECT name, checksum FROM ${quoteQualifiedIdentifier(historyTable)} ORDER BY name`,
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

  throw new Error(
    `Migration history drift detected. Applied migration(s) missing locally: ${unknown.map((record) => record.name).join(", ")}. Use --allow-drift to bypass.`,
  );
}

async function upsertHistory(
  connection: MysqlConnection,
  options: MigrationRunOptions,
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
  options: MigrationDeployOptions,
  migration: MigrationFile,
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
    `INSERT INTO ${quoteQualifiedIdentifier(historyTable)} (name, checksum, adapter, statement_count) VALUES ('${MIGRATION_NAME}', '${checksum}', 'mysql', ${statementCount})`,
    "ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), adapter = VALUES(adapter), applied_at = CURRENT_TIMESTAMP(3), statement_count = VALUES(statement_count)",
  ].join("\n");
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

function compareIndexes(left: MigrationIndexSchema, right: MigrationIndexSchema): number {
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
  left: MigrationEntitySchema,
  right: MigrationEntitySchema,
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
