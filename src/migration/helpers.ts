import { createHash } from "node:crypto";
import type {
  MigrationEntitySchema,
  MigrationIndexSchema,
} from "./types";

export function sanitizeMigrationIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

export function shortenIdentifier(identifier: string, maxLength: number): string {
  if (identifier.length <= maxLength) {
    return identifier;
  }

  const hash = createHash("sha256").update(identifier).digest("hex").slice(0, 12);
  const prefixLength = maxLength - hash.length - 1;
  return `${identifier.slice(0, prefixLength)}_${hash}`;
}

export function foreignKeyName(
  tableName: string,
  columns: string[],
  targetTableName: string,
  maxLength: number,
): string {
  return shortenIdentifier(
    sanitizeMigrationIdentifier(`fk_${tableName}_${columns.join("_")}_${targetTableName}`),
    maxLength,
  );
}

export function compareByName(
  left: { name: string },
  right: { name: string },
): number {
  return left.name.localeCompare(right.name);
}

export function compareMigrationIndexes(
  left: MigrationIndexSchema,
  right: MigrationIndexSchema,
): number {
  return `${left.name ?? ""}.${left.unique ? "unique" : "index"}.${left.columns.join(",")}`.localeCompare(
    `${right.name ?? ""}.${right.unique ? "unique" : "index"}.${right.columns.join(",")}`,
  );
}

export function tableKey(table: { schema?: string; tableName: string }): string {
  return `${table.schema ?? ""}.${table.tableName}`;
}

export function compareMigrationEntities(
  left: MigrationEntitySchema,
  right: MigrationEntitySchema,
): number {
  return `${left.schema ?? ""}.${left.tableName}.${left.className}`.localeCompare(
    `${right.schema ?? ""}.${right.tableName}.${right.className}`,
  );
}

export function compareMigrationTables<TTable extends { schema?: string; tableName: string }>(
  left: TTable,
  right: TTable,
): number {
  return tableKey(left).localeCompare(tableKey(right));
}

export function compareColumnNames(
  left: { columnName: string },
  right: { columnName: string },
): number {
  return left.columnName.localeCompare(right.columnName);
}

export function normalizeTypeUnion(value: string): string {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part !== "undefined" && part !== "null")
    .join(" | ");
}

export function importDriver<TDriver>(specifier: string): Promise<TDriver> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<TDriver>;

  return dynamicImport(specifier);
}
