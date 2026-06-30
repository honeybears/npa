import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LoadNPAMigrationConfigOptions,
  NPAMigrationAdapterName,
  NPAMigrationConfigFile,
  ResolvedNPAMigrationConfig,
} from "./types";

const DEFAULT_CONFIG_FILE = "npa.config.mjs";
const DEFAULT_ENTITIES = ["src/**/*.entity.ts"];
const DEFAULT_MIGRATIONS_DIR = "npa/migrations";
const DEFAULT_MIGRATIONS_TABLE = "_npa_migrations";

export async function loadNPAMigrationConfig(
  options: LoadNPAMigrationConfigOptions,
): Promise<ResolvedNPAMigrationConfig> {
  const config = await loadConfigFile(options.cwd, options.config);
  const url = options.url ?? config.url;
  const adapter = resolveAdapter(options.adapter ?? config.adapter, url);

  return {
    adapter,
    url,
    entities: options.entities ?? normalizeEntities(config.entities),
    migrations: {
      dir: config.migrations?.dir ?? DEFAULT_MIGRATIONS_DIR,
      table: config.migrations?.table ?? DEFAULT_MIGRATIONS_TABLE,
    },
  };
}

export function inferAdapterFromUrl(
  url: string | undefined,
): NPAMigrationAdapterName | undefined {
  if (!url) {
    return undefined;
  }

  const normalized = url.toLowerCase();

  if (normalized.startsWith("postgres://") || normalized.startsWith("postgresql://")) {
    return "postgresql";
  }

  if (normalized.startsWith("mysql://")) {
    return "mysql";
  }

  return undefined;
}

async function loadConfigFile(
  cwd: string,
  configPath: string | undefined,
): Promise<NPAMigrationConfigFile> {
  const resolvedPath = configPath
    ? path.resolve(cwd, configPath)
    : path.resolve(cwd, DEFAULT_CONFIG_FILE);

  if (!fs.existsSync(resolvedPath)) {
    if (configPath) {
      throw new Error(`NPA config file was not found: ${resolvedPath}`);
    }

    return {};
  }

  const imported = await importConfigModule(pathToFileURL(resolvedPath).href);
  const config = imported.default ?? imported;

  if (!isObject(config)) {
    throw new Error("NPA config must export an object.");
  }

  return config as NPAMigrationConfigFile;
}

function resolveAdapter(
  value: string | undefined,
  url: string | undefined,
): NPAMigrationAdapterName {
  const adapter = value ?? inferAdapterFromUrl(url);

  if (adapter !== "postgresql" && adapter !== "mysql") {
    throw new Error("Migration adapter must be postgresql or mysql.");
  }

  return adapter;
}

function normalizeEntities(value: string | string[] | undefined): string[] {
  if (!value) {
    return DEFAULT_ENTITIES;
  }

  const values = Array.isArray(value) ? value : value.split(",");
  const normalized = values.map((item) => item.trim()).filter(Boolean);

  return normalized.length > 0 ? normalized : DEFAULT_ENTITIES;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function importConfigModule(specifier: string): Promise<Record<string, unknown>> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<Record<string, unknown>>;

  return dynamicImport(specifier);
}
