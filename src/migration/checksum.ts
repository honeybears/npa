import { createHash } from "node:crypto";
import { NPAMigrationAdapterName, NPAMigrationEntitySchema } from "./types";

export const NPA_MIGRATION_FORMAT_VERSION = "npa-migration-v5";

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
            mappedBy: relation.mappedBy,
            joinColumn: relation.joinColumn,
            joinTable: relation.joinTable,
            foreignKeyName: relation.foreignKeyName,
            onDelete: relation.onDelete,
            onUpdate: relation.onUpdate,
          }))
          .sort((left, right) =>
            [
              left.kind,
              left.propertyName,
              left.targetClassName,
              left.mappedBy ?? "",
              left.joinColumn ?? "",
              left.joinTable ?? "",
              left.foreignKeyName ?? "",
              left.onDelete ?? "",
              left.onUpdate ?? "",
            ].join(".").localeCompare(
              [
                right.kind,
                right.propertyName,
                right.targetClassName,
                right.mappedBy ?? "",
                right.joinColumn ?? "",
                right.joinTable ?? "",
                right.foreignKeyName ?? "",
                right.onDelete ?? "",
                right.onUpdate ?? "",
              ].join("."),
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
