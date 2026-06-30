import * as path from "node:path";
import { createRequire } from "node:module";
import { NPAMigrationAdapterName, NPAMigrationAdapterRunner } from "./types";

export function loadMigrationAdapterRunner(
  adapter: NPAMigrationAdapterName,
  cwd: string,
): NPAMigrationAdapterRunner {
  const moduleValue = loadAdapterModule(adapter, cwd);
  const exportName = adapter === "mysql" ? "migrateMysql" : "migratePostgresql";
  const runner = (moduleValue as Record<string, unknown>)[exportName];

  if (typeof runner !== "function") {
    throw new Error(`Connector package does not export ${exportName}.`);
  }

  return runner as NPAMigrationAdapterRunner;
}

function loadAdapterModule(adapter: NPAMigrationAdapterName, cwd: string): unknown {
  const packageName =
    adapter === "mysql"
      ? "@honeybeaers/npa-mysql"
      : "@honeybeaers/npa-pg";
  const requireFromCwd = createRequire(path.join(cwd, "package.json"));
  const candidates = [
    packageName,
    path.resolve(
      __dirname,
      "..",
      "..",
      "packages",
      adapter === "mysql" ? "mysql" : "pg",
      "dist",
      adapter === "mysql" ? "mysql-migration" : "postgresql-migration",
    ),
  ];
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      return requireFromCwd(candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(
    `Unable to load ${packageName}. Install the selected NPA connector package. ${errors.join(" ")}`,
  );
}
