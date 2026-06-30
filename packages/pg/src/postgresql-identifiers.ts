import {
  ColumnMetadata,
  EntityMetadata,
  getOptionalEntityMetadata,
} from "@honeybeaers/npa";
import { PostgresqlQueryCompilerOptions } from "./types";

export function quoteTable(options: PostgresqlQueryCompilerOptions): string {
  const metadata = getMetadata(options);
  const tableName = options.tableName ?? metadata?.tableName;

  if (!tableName) {
    throw new Error("PostgreSQL repository requires tableName or entity metadata.");
  }

  const table = quoteQualifiedIdentifier(tableName);
  const schema = options.schema ?? metadata?.schema;

  if (!schema) {
    return table;
  }

  return `${quoteQualifiedIdentifier(schema)}.${table}`;
}

export function propertyToColumn(
  property: string,
  options: PostgresqlQueryCompilerOptions,
): string {
  return quoteIdentifier(resolveColumnName(property, options));
}

export function primaryKeyProperty(
  options: PostgresqlQueryCompilerOptions,
): string {
  return options.primaryKey ?? getMetadata(options)?.primaryColumn?.propertyName ?? "id";
}

export function versionProperty(
  options: PostgresqlQueryCompilerOptions,
): string | undefined {
  return getMetadata(options)?.versionColumn?.propertyName;
}

export function entityColumnProperties(
  options: PostgresqlQueryCompilerOptions,
): string[] | undefined {
  return getMetadata(options)?.columns.map((column) => column.propertyName);
}

function resolveColumnName(
  property: string,
  options: PostgresqlQueryCompilerOptions,
): string {
  return (
    options.columns?.[property] ??
    findColumn(property, options)?.columnName ??
    toSnakeCase(property)
  );
}

function findColumn(
  property: string,
  options: PostgresqlQueryCompilerOptions,
): ColumnMetadata | undefined {
  return getMetadata(options)?.columns.find(
    (column) => column.propertyName === property,
  );
}

function getMetadata(
  options: PostgresqlQueryCompilerOptions,
): EntityMetadata | undefined {
  return getOptionalEntityMetadata(options.entity);
}

export function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split(".").map(quoteIdentifier).join(".");
}

export function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new Error("PostgreSQL identifier must not be empty.");
  }

  return `"${identifier.replace(/"/g, '""')}"`;
}

export function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}
