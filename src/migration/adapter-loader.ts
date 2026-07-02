import * as path from "node:path";
import { createRequire } from "node:module";
import {
  MigrationAdapter,
  MigrationAdapterName,
  MigrationAdapterRunner,
} from "./types";

export function loadMigrationAdapterRunner(
  adapter: MigrationAdapterName,
  cwd: string,
): MigrationAdapterRunner {
  return loadMigrationAdapter(adapter, cwd).push;
}

export function loadMigrationAdapter(
  adapter: MigrationAdapterName,
  cwd: string,
): MigrationAdapter {
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
    plan: plan as MigrationAdapter["plan"],
    push: push as MigrationAdapter["push"],
    deploy: deploy as MigrationAdapter["deploy"],
  };
}

function loadAdapterModule(adapter: MigrationAdapterName, cwd: string): unknown {
  const packageName =
    adapter === "mysql"
      ? "@node-persistence-api/connector-mysql"
      : "@node-persistence-api/connector-pg";
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
