import { NPAMigrationError } from "../error";
import { toSnakeCase } from "../entity/naming";
import {
  compareMigrationEntities,
  compareMigrationTables,
  foreignKeyName,
  tableKey,
} from "./helpers";
import {
  MigrationColumnSchema,
  MigrationEntitySchema,
  MigrationIndexSchema,
  MigrationRelationKind,
  MigrationRelationSchema,
} from "./types";

export interface MigrationTableSchema {
  tableName: string;
  schema?: string;
  columns: MigrationColumnSchema[];
  indexes: MigrationIndexSchema[];
  foreignKeys: MigrationForeignKeySchema[];
  primaryKey?: string[];
}

export interface MigrationForeignKeySchema {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedSchema?: string;
  referencedColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface BuildDesiredMigrationTablesOptions {
  foreignKeyIdentifierMaxLength: number;
  defaultColumnType: (column: MigrationColumnSchema) => string;
}

export function buildDesiredMigrationTables(
  entities: MigrationEntitySchema[],
  options: BuildDesiredMigrationTablesOptions,
): MigrationTableSchema[] {
  const tables = new Map<string, MigrationTableSchema>();
  const sortedEntities = [...entities].sort(compareMigrationEntities);
  const byClassName = new Map(
    sortedEntities.map((entity) => [entity.className, entity]),
  );

  for (const entity of sortedEntities) {
    const table = entityTable(entity, byClassName, options);
    tables.set(tableKey(table), table);
  }

  for (const table of buildJoinTables(sortedEntities, options)) {
    tables.set(tableKey(table), table);
  }

  return [...tables.values()].sort(compareMigrationTables);
}

function entityTable(
  entity: MigrationEntitySchema,
  byClassName: Map<string, MigrationEntitySchema>,
  options: BuildDesiredMigrationTablesOptions,
): MigrationTableSchema {
  const columns = new Map(
    entity.columns.map((column) => [column.columnName, column]),
  );
  const indexes = [...(entity.indexes ?? [])];
  const foreignKeys: MigrationForeignKeySchema[] = [];

  for (const relation of entity.relations ?? []) {
    if (!isOwningForeignKeyRelation(relation)) {
      continue;
    }

    const target = byClassName.get(relation.targetClassName);

    if (!target) {
      throw new NPAMigrationError(
        `@${relation.kind === MigrationRelationKind.ONE_TO_ONE ? "OneToOne" : "ManyToOne"} for ${entity.className}.${relation.propertyName} targets unknown entity ${relation.targetClassName}.`,
        {
          code: "NPA_RELATION_NOT_FOUND",
          details: {
            entity: entity.className,
            relation: relation.propertyName,
            target: relation.targetClassName,
          },
        },
      );
    }

    const targetPrimaryColumns = primaryColumns(target);
    const joinColumns = relationJoinColumnNames(
      relation,
      targetPrimaryColumns,
    );

    for (const [index, joinColumn] of joinColumns.entries()) {
      columns.set(joinColumn, {
        ...relationColumn(targetPrimaryColumns[index], joinColumn, options),
        nullable: relation.nullable ?? true,
      });
    }

    if (relation.kind === MigrationRelationKind.ONE_TO_ONE) {
      indexes.push({ columns: joinColumns, unique: true });
    }

    foreignKeys.push({
      name: relation.foreignKeyName ?? foreignKeyName(
        entity.tableName,
        joinColumns,
        target.tableName,
        options.foreignKeyIdentifierMaxLength,
      ),
      columns: joinColumns,
      referencedSchema: target.schema,
      referencedTable: target.tableName,
      referencedColumns: targetPrimaryColumns.map((column) => column.columnName),
      onDelete: relation.onDelete,
      onUpdate: relation.onUpdate,
    });
  }

  return {
    tableName: entity.tableName,
    schema: entity.schema,
    columns: [...columns.values()],
    indexes,
    foreignKeys,
  };
}

function isOwningForeignKeyRelation(
  relation: MigrationRelationSchema,
): boolean {
  return relation.kind === MigrationRelationKind.MANY_TO_ONE ||
    (relation.kind === MigrationRelationKind.ONE_TO_ONE && !relation.mappedBy);
}

function buildJoinTables(
  entities: MigrationEntitySchema[],
  options: BuildDesiredMigrationTablesOptions,
): MigrationTableSchema[] {
  const byClassName = new Map(
    entities.map((entity) => [entity.className, entity]),
  );
  const tables: MigrationTableSchema[] = [];

  for (const entity of entities) {
    for (const relation of entity.relations ?? []) {
      if (relation.kind !== MigrationRelationKind.MANY_TO_MANY) {
        continue;
      }

      const target = byClassName.get(relation.targetClassName);

      if (!target) {
        throw new NPAMigrationError(
          `@ManyToMany for ${entity.className}.${relation.propertyName} targets unknown entity ${relation.targetClassName}.`,
          {
            code: "NPA_RELATION_NOT_FOUND",
            details: {
              entity: entity.className,
              relation: relation.propertyName,
              target: relation.targetClassName,
            },
          },
        );
      }

      const joinTable = resolveJoinTable(entity, target, relation.joinTable);
      const sourcePrimaryColumns = primaryColumns(entity);
      const targetPrimaryColumns = primaryColumns(target);
      const sourceColumnNames = joinColumnNames(entity, sourcePrimaryColumns);
      const targetColumnNames = joinColumnNames(target, targetPrimaryColumns);

      tables.push({
        ...joinTable,
        columns: [
          ...sourcePrimaryColumns.map((column, index) =>
            relationColumn(column, sourceColumnNames[index], options)),
          ...targetPrimaryColumns.map((column, index) =>
            relationColumn(column, targetColumnNames[index], options)),
        ],
        indexes: [],
        foreignKeys: [
          {
            name: foreignKeyName(
              joinTable.tableName,
              sourceColumnNames,
              entity.tableName,
              options.foreignKeyIdentifierMaxLength,
            ),
            columns: sourceColumnNames,
            referencedSchema: entity.schema,
            referencedTable: entity.tableName,
            referencedColumns: sourcePrimaryColumns.map(
              (column) => column.columnName,
            ),
          },
          {
            name: foreignKeyName(
              joinTable.tableName,
              targetColumnNames,
              target.tableName,
              options.foreignKeyIdentifierMaxLength,
            ),
            columns: targetColumnNames,
            referencedSchema: target.schema,
            referencedTable: target.tableName,
            referencedColumns: targetPrimaryColumns.map(
              (column) => column.columnName,
            ),
          },
        ],
        primaryKey: [...sourceColumnNames, ...targetColumnNames],
      });
    }
  }

  return tables;
}

function relationColumn(
  source: MigrationColumnSchema,
  columnName: string,
  options: BuildDesiredMigrationTablesOptions,
): MigrationColumnSchema {
  return {
    ...source,
    propertyName: columnName,
    columnName,
    dbType: source.dbType ?? options.defaultColumnType(source),
    nullable: false,
    primary: false,
    version: false,
  };
}

function resolveJoinTable(
  source: MigrationEntitySchema,
  target: MigrationEntitySchema,
  joinTable?: string,
): Pick<MigrationTableSchema, "schema" | "tableName"> {
  const rawTableName = joinTable ?? `${source.tableName}_${target.tableName}`;
  const separatorIndex = rawTableName.indexOf(".");

  if (separatorIndex > 0) {
    return {
      schema: rawTableName.slice(0, separatorIndex),
      tableName: rawTableName.slice(separatorIndex + 1),
    };
  }

  return {
    schema: source.schema ?? target.schema,
    tableName: rawTableName,
  };
}

function relationJoinColumnNames(
  relation: MigrationRelationSchema,
  targetPrimaryColumns: MigrationColumnSchema[],
): string[] {
  const explicit = relation.joinColumns ?? (
    relation.joinColumn ? [relation.joinColumn] : undefined
  );

  if (explicit && explicit.length !== targetPrimaryColumns.length) {
    throw new NPAMigrationError(
      `@${relation.kind === MigrationRelationKind.ONE_TO_ONE ? "OneToOne" : "ManyToOne"} ${relation.propertyName} defines ${explicit.length} join column(s), but target has ${targetPrimaryColumns.length} @Id column(s).`,
      {
        code: "NPA_MIGRATION_SCHEMA_PARSE_FAILED",
        details: {
          actualJoinColumns: explicit.length,
          expectedJoinColumns: targetPrimaryColumns.length,
          relation: relation.propertyName,
        },
      },
    );
  }

  return targetPrimaryColumns.map((column, index) =>
    explicit?.[index] ?? `${relation.propertyName}_${column.columnName}`);
}

function joinColumnNames(
  entity: MigrationEntitySchema,
  primaryColumns: MigrationColumnSchema[],
): string[] {
  const prefix = `${toSnakeCase(entity.className)}_`;

  return primaryColumns.map((primary) =>
    primary.columnName.startsWith(prefix)
      ? primary.columnName
      : `${prefix}${primary.columnName}`);
}

function primaryColumns(
  entity: MigrationEntitySchema,
): MigrationColumnSchema[] {
  const primary = entity.columns.filter((column) => column.primary);

  if (primary.length === 0) {
    throw new NPAMigrationError(
      `${entity.className} must declare an @Id column before it can be migrated.`,
      {
        code: "NPA_MIGRATION_ENTITY_ID_REQUIRED",
        details: { entity: entity.className },
      },
    );
  }

  return primary;
}
