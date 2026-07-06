import * as path from "node:path";
import { createRequire } from "node:module";
import { NPAConfigurationError } from "../error";
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
    throw new NPAConfigurationError(`Connector package does not export ${pushName}.`, {
      code: "NPA_CONNECTOR_EXPORT_MISSING",
      details: { exportName: pushName },
    });
  }

  if (typeof plan !== "function") {
    throw new NPAConfigurationError(`Connector package does not export ${planName}.`, {
      code: "NPA_CONNECTOR_EXPORT_MISSING",
      details: { exportName: planName },
    });
  }

  if (typeof deploy !== "function") {
    throw new NPAConfigurationError(`Connector package does not export ${deployName}.`, {
      code: "NPA_CONNECTOR_EXPORT_MISSING",
      details: { exportName: deployName },
    });
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

  throw new NPAConfigurationError(
    `Unable to load ${packageName}. Install the selected NPA connector package. ${errors.join(" ")}`,
    {
      code: "NPA_UNSUPPORTED_ADAPTER",
      details: { adapter, packageName, errors },
    },
  );
}
