import { runDbCommand, runMigrateCommand } from "../migration/cli";
import { generateNPAClient } from "./generate-client";
import { GenerateNPAClientOptions, NPAAdapterName } from "./types";

export async function runNPACli(argv: string[], cwd = process.cwd()): Promise<number> {
  const [command, ...args] = argv;

  try {
    if (command === "generate") {
      const options = parseGenerateOptions(args, cwd);
      const result = generateNPAClient(options);
      process.stdout.write(`Generated ${result.path}\n`);
      return 0;
    }

    if (command === "migrate") {
      await runMigrateCommand(args, cwd);
      return 0;
    }

    if (command === "db") {
      await runDbCommand(args, cwd);
      return 0;
    }

    printHelp();
    return command ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseGenerateOptions(
  args: string[],
  cwd: string,
): GenerateNPAClientOptions {
  const values = parseFlags(args);
  const adapter = (values.adapter ?? "postgresql") as NPAAdapterName;

  if (adapter !== "postgresql" && adapter !== "mysql") {
    throw new Error(`Unsupported adapter "${adapter}". Use postgresql or mysql.`);
  }

  return {
    cwd,
    adapter,
    entities: splitList(values.entities ?? "src/**/*.entity.ts"),
    out: values.out ?? "src/generated/npa.ts",
    coreLibraryImport: values.coreLibrary,
    adapterLibraryImport: values.adapterLibrary,
    libraryImport: values.library,
  };
}

function parseFlags(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}".`);
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? args[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}.`);
    }

    values[toCamelCase(rawName)] = value;

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return values;
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

function printHelp(): void {
  process.stdout.write(`Usage:
  npa generate [--entities "src/**/*.entity.ts"] [--out src/generated/npa.ts]
  npa db push [--config npa.config.mjs] [--dry-run]
  npa migrate dev [--name init] [--config npa.config.mjs]
  npa migrate deploy [--config npa.config.mjs]

Options:
  --adapter <name>       Adapter used by the generated client: postgresql or mysql.
  --entities <patterns>  Comma-separated entity source globs.
  --out <file>           Generated TypeScript output file.
  --core-library <spec>  Import specifier for the NPA core package.
  --adapter-library <s>  Import specifier for the selected connector package.
  --library <specifier>  Legacy import specifier used for both core and adapter.

Database and migrate options:
  --config <file>       Config file path. Defaults to npa.config.mjs when present.
  --adapter <name>      Migration adapter: postgresql or mysql.
  --url <url>           Database URL. Required unless --dry-run is used.
  --entities <patterns> Comma-separated entity source globs.
  --name <name>         Migration directory suffix for migrate dev.
  --create-only         Create a migration file without applying it.
  --dry-run             Print SQL without changing the database.
`);
}
