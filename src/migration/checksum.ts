import { createHash } from "node:crypto";
import { NPAMigrationAdapterName, NPAMigrationEntitySchema } from "./types";

export const NPA_MIGRATION_FORMAT_VERSION = "npa-migration-v3";

export function createMigrationChecksum(
  adapter: NPAMigrationAdapterName,
  entities: NPAMigrationEntitySchema[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(createMigrationSnapshot(adapter, entities)))
    .digest("hex");
}

export function createMigrationSnapshot(
  adapter: NPAMigrationAdapterName,
  entities: NPAMigrationEntitySchema[],
): unknown {
  return {
    version: NPA_MIGRATION_FORMAT_VERSION,
    adapter,
    entities: entities
      .map((entity) => ({
        className: entity.className,
        tableName: entity.tableName,
        schema: entity.schema,
        columns: entity.columns
          .map((column) => ({
            propertyName: column.propertyName,
            columnName: column.columnName,
            tsType: normalizeType(column.tsType),
            dbType: column.dbType,
            nullable: column.nullable,
            primary: column.primary,
            version: column.version,
          }))
          .sort((left, right) => left.columnName.localeCompare(right.columnName)),
        indexes: (entity.indexes ?? [])
          .map((index) => ({
            name: index.name,
            columns: [...index.columns].sort(),
            unique: index.unique,
          }))
          .sort((left, right) =>
            `${left.unique ? "unique" : "index"}.${left.name ?? ""}.${left.columns.join(",")}`.localeCompare(
              `${right.unique ? "unique" : "index"}.${right.name ?? ""}.${right.columns.join(",")}`,
            ),
          ),
        relations: (entity.relations ?? [])
          .map((relation) => ({
            propertyName: relation.propertyName,
            kind: relation.kind,
            targetClassName: relation.targetClassName,
            joinTable: relation.joinTable,
          }))
          .sort((left, right) =>
            `${left.kind}.${left.propertyName}.${left.targetClassName}.${left.joinTable ?? ""}`.localeCompare(
              `${right.kind}.${right.propertyName}.${right.targetClassName}.${right.joinTable ?? ""}`,
            ),
          ),
      }))
      .sort((left, right) =>
        `${left.schema ?? ""}.${left.tableName}.${left.className}`.localeCompare(
          `${right.schema ?? ""}.${right.tableName}.${right.className}`,
        ),
      ),
  };
}

function normalizeType(value: string): string {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part !== "undefined" && part !== "null")
    .join(" | ");
}
