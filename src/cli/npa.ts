#!/usr/bin/env node
import { runDbCommand, runMigrateCommand } from "../migration/cli";

async function runNPACli(argv: string[], cwd = process.cwd()): Promise<number> {
  const [command, ...args] = argv;

  try {
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

function printHelp(): void {
  process.stdout.write(`Usage:
  npa db push [--config npa.config.mjs] [--dry-run] [--allow-destructive]
  npa migrate dev [--name init] [--config npa.config.mjs]
  npa migrate deploy [--config npa.config.mjs]

Database and migrate options:
  --config <file>       Config file path. Defaults to npa.config.mjs when present.
  --adapter <name>      Migration adapter: postgresql or mysql.
  --url <url>           Database URL. Required unless --dry-run is used.
  --entities <patterns> Comma-separated entity source globs.
  --migrations-dir <dir> Directory for migration files. Defaults to npa/migrations.
  --name <name>         Migration directory suffix for migrate dev.
  --create-only         Create a migration file without applying it.
  --rename <mapping>    Explicit rename, e.g. table:old=new or column:users.old=new.
  --allow-destructive   Allow drops and risky type/nullability changes.
  --allow-drift         Allow applied migration history that is missing locally.
  --dry-run             Print SQL without changing the database.
`);
}

void runNPACli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
