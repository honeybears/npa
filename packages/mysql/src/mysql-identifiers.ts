import {
  ColumnMetadata,
  EntityMetadata,
  getOptionalEntityMetadata,
} from "@honeybeaers/npa";
import { MysqlQueryCompilerOptions } from "./types";

export function quoteMysqlTable(options: MysqlQueryCompilerOptions): string {
  const metadata = getMetadata(options);
  const tableName = options.tableName ?? metadata?.tableName;

  if (!tableName) {
    throw new Error("MySQL repository requires tableName or entity metadata.");
  }

  const table = quoteQualifiedIdentifier(tableName);
  const schema = options.schema ?? metadata?.schema;

  if (!schema) {
    return table;
  }

  return `${quoteQualifiedIdentifier(schema)}.${table}`;
}

export function mysqlPropertyToColumn(
  property: string,
  options: MysqlQueryCompilerOptions,
): string {
  return quoteIdentifier(resolveColumnName(property, options));
}

export function mysqlPrimaryKeyProperty(
  options: MysqlQueryCompilerOptions,
): string {
  return options.primaryKey ?? getMetadata(options)?.primaryColumn?.propertyName ?? "id";
}

export function mysqlVersionProperty(
  options: MysqlQueryCompilerOptions,
): string | undefined {
  return getMetadata(options)?.versionColumn?.propertyName;
}

export function mysqlEntityColumnProperties(
  options: MysqlQueryCompilerOptions,
): string[] | undefined {
  return getMetadata(options)?.columns.map((column) => column.propertyName);
}

function resolveColumnName(
  property: string,
  options: MysqlQueryCompilerOptions,
): string {
  return (
    options.columns?.[property] ??
    findColumn(property, options)?.columnName ??
    toSnakeCase(property)
  );
}

function findColumn(
  property: string,
  options: MysqlQueryCompilerOptions,
): ColumnMetadata | undefined {
  return getMetadata(options)?.columns.find(
    (column) => column.propertyName === property,
  );
}

function getMetadata(
  options: MysqlQueryCompilerOptions,
): EntityMetadata | undefined {
  return getOptionalEntityMetadata(options.entity);
}

function quoteQualifiedIdentifier(identifier: string): string {
  return identifier.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new Error("MySQL identifier must not be empty.");
  }

  return `\`${identifier.replace(/`/g, "``")}\``;
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}
