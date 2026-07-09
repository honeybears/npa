import {
  getOptionalEntityMetadata,
  NPAPersistenceError,
} from "@node-persistence-api/core/adapter";
import {
  mysqlEntityColumnProperties,
  normalizeMysqlPropertyValues,
  mysqlPrimaryKeyProperties,
  mysqlPropertyToColumns,
  mysqlVersionProperty,
  quoteMysqlTable,
} from "./mysql-identifiers";
import { MysqlCompiledQuery, MysqlQueryCompilerOptions } from "./types";

export function compileMysqlInsert<TEntity extends object>(
  entity: TEntity,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  const primaryKeys = mysqlPrimaryKeyProperties(options);
  const entries = withDefaultVersionEntry(
    definedEntries(entity, options).filter(
      ([property, value]) =>
        !primaryKeys.includes(property) ||
        shouldInsertPrimaryKey(property, value, options),
    ),
    options,
  );

  if (entries.length === 0) {
    throw new NPAPersistenceError("Cannot insert an entity without values.", {
      code: "NPA_INSERT_VALUES_REQUIRED",
    });
  }

  const columnValues = expandMysqlColumnValues(entries, options);
  const columns = columnValues.map((entry) => entry.column);
  const values = columnValues.map((entry) => entry.value);
  const placeholders = values.map(() => "?");

  return {
    text: `INSERT INTO ${quoteMysqlTable(options)} (${columns.join(
      ", ",
    )}) VALUES (${placeholders.join(", ")})`,
    values,
  };
}

export function compileMysqlUpdate<TEntity extends object>(
  id: unknown,
  patch: TEntity,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  assertId(id);

  const primaryKeys = mysqlPrimaryKeyProperties(options);
  const version = mysqlVersionProperty(options);
  const entries = definedEntries(patch, options).filter(
    ([property]) => !primaryKeys.includes(property) && property !== version,
  );

  if (entries.length === 0) {
    throw new NPAPersistenceError("Cannot update an entity without changed values.", {
      code: "NPA_UPDATE_VALUES_REQUIRED",
    });
  }

  const columnValues = expandMysqlColumnValues(entries, options);
  const values = columnValues.map((entry) => entry.value);
  const assignments = columnValues.map(
    (entry) => `${entry.column} = ?`,
  );
  const where = compileIdWhere(id, options, values);

  return {
    text: `UPDATE ${quoteMysqlTable(options)} SET ${assignments.join(
      ", ",
    )} WHERE ${where}`,
    values,
  };
}

export function compileMysqlVersionedUpdate<TEntity extends object>(
  id: unknown,
  patch: TEntity,
  expectedVersion: unknown,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  assertId(id);
  assertVersion(expectedVersion);

  const primaryKeys = mysqlPrimaryKeyProperties(options);
  const version = requireMysqlVersionProperty(options);
  const entries = definedEntries(patch, options).filter(
    ([property]) => !primaryKeys.includes(property) && property !== version,
  );

  if (entries.length === 0) {
    throw new NPAPersistenceError("Cannot update an entity without changed values.", {
      code: "NPA_UPDATE_VALUES_REQUIRED",
    });
  }

  const columnValues = expandMysqlColumnValues(entries, options);
  const values = columnValues.map((entry) => entry.value);
  const assignments = columnValues.map(
    (entry) => `${entry.column} = ?`,
  );
  const versionColumn = mysqlPropertyToColumns(version, options)[0];
  assignments.push(`${versionColumn} = ${versionColumn} + 1`);
  const where = compileIdWhere(id, options, values);
  values.push(expectedVersion);

  return {
    text: `UPDATE ${quoteMysqlTable(options)} SET ${assignments.join(
      ", ",
    )} WHERE ${where} AND ${versionColumn} = ?`,
    values,
  };
}

export function compileMysqlDeleteById(
  id: unknown,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  assertId(id);
  const values: unknown[] = [];

  return {
    text: `DELETE FROM ${quoteMysqlTable(options)} WHERE ${compileIdWhere(id, options, values)}`,
    values,
  };
}

export function compileMysqlFindById(
  id: unknown,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  assertId(id);
  const values: unknown[] = [];

  return {
    text: `SELECT * FROM ${quoteMysqlTable(options)} WHERE ${compileIdWhere(id, options, values)} LIMIT 1`,
    values,
  };
}

export function compileMysqlExistsById(
  id: unknown,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  assertId(id);
  const values: unknown[] = [];

  return {
    text: `SELECT EXISTS(SELECT 1 FROM ${quoteMysqlTable(
      options,
    )} WHERE ${compileIdWhere(id, options, values)}) AS \`exists\``,
    values,
  };
}

export function compileMysqlFindAll(
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  return {
    text: `SELECT * FROM ${quoteMysqlTable(options)}`,
    values: [],
  };
}

export function compileMysqlCount(
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  return {
    text: `SELECT COUNT(*) AS \`count\` FROM ${quoteMysqlTable(options)}`,
    values: [],
  };
}

export function compileMysqlDeleteAll(
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  return {
    text: `DELETE FROM ${quoteMysqlTable(options)}`,
    values: [],
  };
}

export function getMysqlPrimaryKeyValue<TEntity extends object>(
  entity: TEntity,
  options: MysqlQueryCompilerOptions,
): unknown {
  const record = entity as Record<string, unknown>;
  const primaryKeys = mysqlPrimaryKeyProperties(options);

  if (primaryKeys.length === 1) {
    const property = primaryKeys[0];
    return normalizePrimaryKeyValue(property, record[property], options);
  }

  const entries = primaryKeys.map(
    (property) => [
      property,
      normalizePrimaryKeyValue(property, record[property], options),
    ] as const,
  );
  return entries.some(([, value]) => value === null || value === undefined)
    ? undefined
    : Object.fromEntries(entries);
}

function expandMysqlColumnValues(
  entries: Array<[string, unknown]>,
  options: MysqlQueryCompilerOptions,
): Array<{ column: string; value: unknown }> {
  return entries.flatMap(([property, value]) => {
    const columns = mysqlPropertyToColumns(property, options);
    const values = normalizeMysqlPropertyValues(property, value, options);

    return columns.map((column, index) => ({
      column,
      value: values[index],
    }));
  });
}

function shouldInsertPrimaryKey(
  property: string,
  value: unknown,
  options: MysqlQueryCompilerOptions,
): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  return !isGeneratedPrimaryKey(property, options) || Boolean(value);
}

function normalizePrimaryKeyValue(
  property: string,
  value: unknown,
  options: MysqlQueryCompilerOptions,
): unknown {
  return isGeneratedPrimaryKey(property, options) && !value
    ? undefined
    : value;
}

function isGeneratedPrimaryKey(
  property: string,
  options: MysqlQueryCompilerOptions,
): boolean {
  const generationStrategy = getOptionalEntityMetadata(options.entity)
    ?.columns.find((column) => column.primary && column.propertyName === property)
    ?.generationStrategy;

  return generationStrategy !== undefined && generationStrategy !== "NONE";
}

function withDefaultVersionEntry(
  entries: Array<[string, unknown]>,
  options: MysqlQueryCompilerOptions,
): Array<[string, unknown]> {
  const version = mysqlVersionProperty(options);

  if (!version) {
    return entries;
  }

  const versionIndex = entries.findIndex(([property]) => property === version);

  if (versionIndex < 0) {
    return [...entries, [version, 0]];
  }

  if (entries[versionIndex][1] === null || entries[versionIndex][1] === undefined) {
    const nextEntries = [...entries];
    nextEntries[versionIndex] = [version, 0];
    return nextEntries;
  }

  return entries;
}

function requireMysqlVersionProperty(
  options: MysqlQueryCompilerOptions,
): string {
  const version = mysqlVersionProperty(options);

  if (!version) {
    throw new NPAPersistenceError("A @Version column is required for versioned updates.", {
      code: "NPA_VERSION_COLUMN_REQUIRED",
    });
  }

  return version;
}

function assertVersion(version: unknown): void {
  if (version === null || version === undefined) {
    throw new NPAPersistenceError("Version value is required.", {
      code: "NPA_VERSION_VALUE_REQUIRED",
    });
  }
}

function definedEntries<TEntity extends object>(
  entity: TEntity,
  options: MysqlQueryCompilerOptions,
): Array<[string, unknown]> {
  const allowedProperties = mysqlEntityColumnProperties(options);
  return Object.entries(entity).filter(([property, value]) => {
    if (value === undefined) {
      return false;
    }

    return allowedProperties ? allowedProperties.includes(property) : true;
  });
}

function assertId(id: unknown): void {
  if (id === null || id === undefined) {
    throw new NPAPersistenceError("Primary key value is required.", {
      code: "NPA_PRIMARY_KEY_REQUIRED",
    });
  }
}

function compileIdWhere(
  id: unknown,
  options: MysqlQueryCompilerOptions,
  values: unknown[],
): string {
  return primaryKeyValueEntries(id, options).map(([property, value]) => {
    values.push(normalizeMysqlPropertyValues(property, value, options)[0]);
    return `${mysqlPropertyToColumns(property, options)[0]} = ?`;
  }).join(" AND ");
}

function primaryKeyValueEntries(
  id: unknown,
  options: MysqlQueryCompilerOptions,
): Array<[string, unknown]> {
  const primaryKeys = mysqlPrimaryKeyProperties(options);

  if (primaryKeys.length === 1) {
    assertId(id);
    return [[primaryKeys[0], id]];
  }

  if (id === null || id === undefined || typeof id !== "object") {
    throw new NPAPersistenceError("Composite primary key value must be an object.", {
      code: "NPA_COMPOSITE_ID_OBJECT_REQUIRED",
    });
  }

  const record = id as Record<string, unknown>;
  return primaryKeys.map((property) => {
    const value = record[property];
    assertId(value);
    return [property, value];
  });
}
