import { loadMigrationAdapterRunner } from "./adapter-loader";
import { createMigrationChecksum } from "./checksum";
import { loadNPAMigrationConfig } from "./config";
import { discoverEntitySchemas } from "./entity-schema";
import { NPAMigrationResult } from "./types";

export async function runMigrateCommand(args: string[], cwd: string): Promise<void> {
  const values = parseFlags(args, new Set(["dry-run"]));
  const dryRun = values.dryRun === "true";
  const config = await loadNPAMigrationConfig({
    cwd,
    config: values.config,
    adapter: values.adapter,
    url: values.url,
    entities: values.entities ? splitList(values.entities) : undefined,
  });

  if (!dryRun && !config.url) {
    throw new Error("Migration requires database url unless --dry-run is used.");
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
  });

  writeResult(result, config.adapter);
}

function writeResult(result: NPAMigrationResult, adapter: string): void {
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

  process.stdout.write(
    `Applied migration schema (${result.statementCount} statements, checksum ${result.checksum}).\n`,
  );
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

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}
