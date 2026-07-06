import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { NPAConfigurationError, NPAMigrationError } from "../error";
import {
  LoadMigrationConfigOptions,
  MigrationAdapterName,
  MigrationConfigFile,
  ResolvedMigrationConfig,
} from "./types";

const DEFAULT_CONFIG_FILE = "npa.config.mjs";
const DEFAULT_ENTITIES = ["src/**/*.entity.ts"];
const DEFAULT_MIGRATIONS_DIR = "npa/migrations";
const DEFAULT_MIGRATIONS_TABLE = "_npa_migrations";

export async function loadMigrationConfig(
  options: LoadMigrationConfigOptions,
): Promise<ResolvedMigrationConfig> {
  const config = await loadConfigFile(options.cwd, options.config);
  const url = options.url ?? config.url;
  const adapter = resolveAdapter(options.adapter ?? config.adapter, url);

  assertUrlMatchesAdapter(url, adapter);

  return {
    adapter,
    url,
    entities: options.entities ?? normalizeEntities(config.entities),
    migrations: {
      dir: options.migrationsDir ?? config.migrations?.dir ?? DEFAULT_MIGRATIONS_DIR,
      table: config.migrations?.table ?? DEFAULT_MIGRATIONS_TABLE,
    },
  };
}

export function inferAdapterFromUrl(
  url: string | undefined,
): MigrationAdapterName | undefined {
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
): Promise<MigrationConfigFile> {
  const resolvedPath = configPath
    ? path.resolve(cwd, configPath)
    : path.resolve(cwd, DEFAULT_CONFIG_FILE);

  if (!fs.existsSync(resolvedPath)) {
    if (configPath) {
      throw new NPAConfigurationError(`NPA config file was not found: ${resolvedPath}`, {
        code: "NPA_CONFIG_NOT_FOUND",
        details: { configPath: resolvedPath },
      });
    }

    return {};
  }

  const imported = await importConfigModule(pathToFileURL(resolvedPath).href);
  const config = imported.default ?? imported;

  if (!isObject(config)) {
    throw new NPAConfigurationError("NPA config must export an object.", {
      code: "NPA_INVALID_CONFIG",
      details: { configPath: resolvedPath },
    });
  }

  return config as MigrationConfigFile;
}

function resolveAdapter(
  value: string | undefined,
  url: string | undefined,
): MigrationAdapterName {
  const inferredAdapter = inferAdapterFromUrl(url);

  if (!value && url && !inferredAdapter) {
    throw new NPAMigrationError(
      "Migration url must start with postgres://, postgresql://, or mysql://.",
      {
        code: "NPA_MIGRATION_DATABASE_URL_REQUIRED",
        details: { url },
      },
    );
  }

  const adapter = value ?? inferredAdapter;

  if (adapter !== "postgresql" && adapter !== "mysql") {
    throw new NPAConfigurationError("Migration adapter must be postgresql or mysql.", {
      code: value ? "NPA_UNSUPPORTED_ADAPTER" : "NPA_ADAPTER_REQUIRED",
      details: { adapter },
    });
  }

  return adapter;
}

function assertUrlMatchesAdapter(
  url: string | undefined,
  adapter: MigrationAdapterName,
): void {
  const inferredAdapter = inferAdapterFromUrl(url);

  if (url && !inferredAdapter) {
    throw new NPAMigrationError(
      "Migration url must start with postgres://, postgresql://, or mysql://.",
      {
        code: "NPA_MIGRATION_DATABASE_URL_REQUIRED",
        details: { url },
      },
    );
  }

  if (inferredAdapter && inferredAdapter !== adapter) {
    throw new NPAConfigurationError(
      `Migration adapter ${adapter} does not match ${inferredAdapter} url.`,
      {
        code: "NPA_INVALID_CONFIG",
        details: { adapter, inferredAdapter },
      },
    );
  }
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
