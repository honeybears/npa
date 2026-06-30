import * as path from "node:path";
import { createRequire } from "node:module";
import {
  NPAMigrationAdapter,
  NPAMigrationAdapterName,
  NPAMigrationAdapterRunner,
} from "./types";

export function loadMigrationAdapterRunner(
  adapter: NPAMigrationAdapterName,
  cwd: string,
): NPAMigrationAdapterRunner {
  return loadMigrationAdapter(adapter, cwd).push;
}

export function loadMigrationAdapter(
  adapter: NPAMigrationAdapterName,
  cwd: string,
): NPAMigrationAdapter {
  const moduleValue = loadAdapterModule(adapter, cwd);
  const exports = moduleValue as Record<string, unknown>;
  const pushName = adapter === "mysql" ? "migrateMysql" : "migratePostgresql";
  const planName = adapter === "mysql" ? "planMysqlMigration" : "planPostgresqlMigration";
  const deployName =
    adapter === "mysql" ? "deployMysqlMigrations" : "deployPostgresqlMigrations";
  const push = exports[pushName];
  const plan = exports[planName];
  const deploy = exports[deployName];

  if (typeof push !== "function") {
    throw new Error(`Connector package does not export ${pushName}.`);
  }

  if (typeof plan !== "function") {
    throw new Error(`Connector package does not export ${planName}.`);
  }

  if (typeof deploy !== "function") {
    throw new Error(`Connector package does not export ${deployName}.`);
  }

  return {
    plan: plan as NPAMigrationAdapter["plan"],
    push: push as NPAMigrationAdapter["push"],
    deploy: deploy as NPAMigrationAdapter["deploy"],
  };
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
