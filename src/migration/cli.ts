import * as path from "node:path";
import { loadMigrationAdapter, loadMigrationAdapterRunner } from "./adapter-loader";
import { createMigrationChecksum } from "./checksum";
import { loadMigrationConfig } from "./config";
import { discoverEntitySchemas } from "./entity-schema";
import { loadMigrationFiles, writeMigrationFile } from "./files";
import { assertSafeMigrationStatements } from "./safety";
import {
  MigrationDeployResult,
  MigrationFile,
  MigrationRename,
  MigrationResult,
  MigrationTableReference,
} from "./types";

export async function runMigrateCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...subcommandArgs] = args;

  if (subcommand === "dev") {
    await runMigrateDevCommand(subcommandArgs, cwd);
    return;
  }

  if (subcommand === "deploy") {
    await runMigrateDeployCommand(subcommandArgs, cwd);
    return;
  }

  if (subcommand && !subcommand.startsWith("--")) {
    throw new Error(`Unsupported migrate command "${subcommand}". Use dev or deploy.`);
  }

  await runDbPushCommand(args, cwd, { legacy: true });
}

export async function runDbCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...subcommandArgs] = args;

  if (subcommand !== "push") {
    throw new Error("Unsupported db command. Use `npa db push`.");
  }

  await runDbPushCommand(subcommandArgs, cwd);
}

async function runDbPushCommand(
  args: string[],
  cwd: string,
  options: { legacy?: boolean } = {},
): Promise<void> {
  const values = parseFlags(args, new Set(["dry-run", "allow-destructive"]));
  const dryRun = values.dryRun === "true";
  const allowDestructive = values.allowDestructive === "true";
  const renames = values.rename ? parseRenames(values.rename) : [];
  const config = await loadConfig(cwd, values);

  if (!dryRun && !config.url) {
    throw new Error("Database push requires database url unless --dry-run is used.");
  }

  if (renames.length > 0 && !config.url) {
    throw new Error("Migration renames require database url.");
  }

  const entities = discoverEntitySchemas(cwd, config.entities);

  if (entities.length === 0) {
    throw new Error(
      `No @Entity classes found for migration pattern(s): ${config.entities.join(", ")}`,
    );
  }

  const checksum = createMigrationChecksum(config.adapter, entities);
  const runner = loadMigrationAdapterRunner(config.adapter, cwd);
  const result = await runner({
    adapter: config.adapter,
    url: config.url,
    entities,
    checksum,
    historyTable: config.migrations.table,
    dryRun,
    allowDestructive,
    renames,
  });

  writePushResult(result, config.adapter, options.legacy === true);
}

async function runMigrateDevCommand(args: string[], cwd: string): Promise<void> {
  const values = parseFlags(args, new Set([
    "dry-run",
    "create-only",
    "allow-destructive",
    "allow-drift",
  ]));
  const dryRun = values.dryRun === "true";
  const createOnly = values.createOnly === "true";
  const allowDestructive = values.allowDestructive === "true";
  const allowDrift = values.allowDrift === "true";
  const renames = values.rename ? parseRenames(values.rename) : [];
  const config = await loadConfig(cwd, values);

  if (!dryRun && !config.url) {
    throw new Error("Migration dev requires database url unless --dry-run is used.");
  }

  if (renames.length > 0 && !config.url) {
    throw new Error("Migration renames require database url.");
  }

  const entities = discoverEntitySchemas(cwd, config.entities);

  if (entities.length === 0) {
    throw new Error(
      `No @Entity classes found for migration pattern(s): ${config.entities.join(", ")}`,
    );
  }

  const adapter = loadMigrationAdapter(config.adapter, cwd);
  const existingMigrations = loadMigrationFiles(cwd, config.migrations.dir);

  if (!dryRun && existingMigrations.length > 0) {
    await adapter.deploy({
      adapter: config.adapter,
      url: config.url,
      historyTable: config.migrations.table,
      migrations: existingMigrations,
      allowDestructive,
      allowDrift,
    });
  }

  const checksum = createMigrationChecksum(config.adapter, entities);
  const plan = await adapter.plan({
    adapter: config.adapter,
    url: config.url,
    entities,
    checksum,
    historyTable: config.migrations.table,
    dryRun: true,
    allowDestructive,
    renames,
  });

  if (dryRun) {
    writeMigrateDevDryRun(plan, config.adapter, values.name);
    return;
  }

  if (plan.statements.length === 0) {
    process.stdout.write("No schema changes found. Database is up to date.\n");
    return;
  }

  assertSafeMigrationStatements(plan.statements, { allowDestructive });

  const migration = writeMigrationFile(
    cwd,
    config.migrations.dir,
    values.name,
    plan.statements,
    { downStatements: plan.downStatements },
  );

  if (createOnly) {
    process.stdout.write(
      `Created migration ${relativePath(cwd, migration.filePath)} (${migration.statementCount} statements).\n`,
    );
    return;
  }

  const deployResult = await adapter.deploy({
    adapter: config.adapter,
    url: config.url,
    historyTable: config.migrations.table,
    migrations: [migration],
    allowDestructive,
    allowDrift: true,
  });

  process.stdout.write(
    `Created and applied migration ${migration.name} (${deployResult.statementCount} statements).\n`,
  );
}

async function runMigrateDeployCommand(args: string[], cwd: string): Promise<void> {
  const values = parseFlags(args, new Set([
    "dry-run",
    "allow-destructive",
    "allow-drift",
  ]));
  const dryRun = values.dryRun === "true";
  const allowDestructive = values.allowDestructive === "true";
  const allowDrift = values.allowDrift === "true";
  const config = await loadConfig(cwd, values);

  if (!config.url) {
    throw new Error("Migration deploy requires database url.");
  }

  const migrations = loadMigrationFiles(cwd, config.migrations.dir);

  if (migrations.length === 0) {
    process.stdout.write(
      `No migration files found in ${config.migrations.dir}.\n`,
    );
    return;
  }

  const adapter = loadMigrationAdapter(config.adapter, cwd);
  const result = await adapter.deploy({
    adapter: config.adapter,
    url: config.url,
    historyTable: config.migrations.table,
    migrations,
    dryRun,
    allowDestructive,
    allowDrift,
  });

  writeDeployResult(result, migrations, dryRun);
}

function writePushResult(
  result: MigrationResult,
  adapter: string,
  legacy: boolean,
): void {
  if (result.status === "dry-run") {
    process.stdout.write(`Adapter: ${adapter}\n`);
    process.stdout.write(`Checksum: ${result.checksum}\n`);
    process.stdout.write(`Statements: ${result.statementCount}\n`);

    for (const statement of result.statements) {
      process.stdout.write(`${statement};\n`);
    }

    return;
  }

  if (result.status === "noop") {
    process.stdout.write(`Database schema is up to date (${result.checksum}).\n`);
    return;
  }

  const action = legacy ? "Applied migration schema" : "Pushed database schema";
  process.stdout.write(
    `${action} (${result.statementCount} statements, checksum ${result.checksum}).\n`,
  );
}

function writeMigrateDevDryRun(
  result: MigrationResult,
  adapter: string,
  name: string | undefined,
): void {
  process.stdout.write(`Adapter: ${adapter}\n`);
  process.stdout.write(`Migration name: ${name ?? "migration"}\n`);
  process.stdout.write(`Checksum: ${result.checksum}\n`);
  process.stdout.write(`Statements: ${result.statementCount}\n`);

  for (const statement of result.statements) {
    process.stdout.write(`${statement};\n`);
  }

  if (result.downStatements?.length) {
    process.stdout.write(`Down statements: ${result.downStatementCount ?? result.downStatements.length}\n`);

    for (const statement of result.downStatements) {
      process.stdout.write(`${statement};\n`);
    }
  }
}

function writeDeployResult(
  result: MigrationDeployResult,
  migrations: MigrationFile[],
  dryRun: boolean,
): void {
  if (dryRun) {
    const pending = result.migrations.filter((migration) => migration.status === "pending");
    process.stdout.write(`Pending migrations: ${pending.length}\n`);

    for (const migration of pending) {
      process.stdout.write(`${migration.name} (${migration.statementCount} statements)\n`);
    }

    return;
  }

  if (result.status === "noop") {
    process.stdout.write(`No pending migrations (${migrations.length} checked).\n`);
    return;
  }

  const applied = result.migrations.filter((migration) => migration.status === "applied");
  process.stdout.write(
    `Applied ${applied.length} migration(s) (${result.statementCount} statements).\n`,
  );
}

function loadConfig(cwd: string, values: Record<string, string>) {
  return loadMigrationConfig({
    cwd,
    config: values.config,
    adapter: values.adapter,
    url: values.url,
    entities: values.entities ? splitList(values.entities) : undefined,
  });
}

function relativePath(cwd: string, filePath: string | undefined): string {
  if (!filePath) {
    return "migration.sql";
  }

  return path.relative(cwd, filePath);
}

function parseFlags(args: string[], booleanFlags = new Set<string>()): Record<string, string> {
  const values: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}".`);
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const name = toCamelCase(rawName);

    if (booleanFlags.has(rawName)) {
      if (inlineValue !== undefined) {
        values[name] = parseBoolean(rawName, inlineValue);
      } else {
        values[name] = "true";
      }

      continue;
    }

    const value = inlineValue ?? args[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}.`);
    }

    values[name] = value;

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return values;
}

function parseBoolean(name: string, value: string): string {
  if (value !== "true" && value !== "false") {
    throw new Error(`--${name} must be true or false.`);
  }

  return value;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRenames(value: string): MigrationRename[] {
  return splitList(value).map(parseRename);
}

function parseRename(value: string): MigrationRename {
  const [kind, mapping] = value.split(":", 2);
  const [from, to] = mapping?.split("=", 2) ?? [];

  if (!from || !to) {
    throw new Error(
      `Invalid --rename value "${value}". Use table:old=new or column:table.old=new.`,
    );
  }

  if (kind === "table") {
    return {
      kind,
      from: parseTableReference(from),
      to: parseTableReference(to),
    };
  }

  if (kind === "column") {
    const source = parseColumnReference(from);
    const target = to.includes(".") ? parseColumnReference(to) : undefined;

    if (target && tableKey(source.table) !== tableKey(target.table)) {
      throw new Error("Column rename source and target must be on the same table.");
    }

    return {
      kind,
      table: source.table,
      from: source.columnName,
      to: target?.columnName ?? to,
    };
  }

  throw new Error(
    `Invalid --rename kind "${kind}". Use table:old=new or column:table.old=new.`,
  );
}

function parseTableReference(value: string): MigrationTableReference {
  const parts = value.split(".").filter(Boolean);

  if (parts.length === 1) {
    return { tableName: parts[0] };
  }

  if (parts.length === 2) {
    return { schema: parts[0], tableName: parts[1] };
  }

  throw new Error(`Invalid table reference "${value}".`);
}

function parseColumnReference(value: string): {
  table: MigrationTableReference;
  columnName: string;
} {
  const parts = value.split(".").filter(Boolean);

  if (parts.length === 2) {
    return {
      table: { tableName: parts[0] },
      columnName: parts[1],
    };
  }

  if (parts.length === 3) {
    return {
      table: { schema: parts[0], tableName: parts[1] },
      columnName: parts[2],
    };
  }

  throw new Error(`Invalid column reference "${value}".`);
}

function tableKey(table: MigrationTableReference): string {
  return `${table.schema ?? ""}.${table.tableName}`;
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}
