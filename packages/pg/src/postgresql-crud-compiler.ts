import {
  PostgresqlCompiledQuery,
  PostgresqlQueryCompilerOptions,
} from "./types";
import {
  entityColumnProperties,
  primaryKeyProperties as resolvePrimaryKeyProperties,
  primaryKeyProperty as resolvePrimaryKeyProperty,
  normalizePropertyValues,
  propertyToColumns,
  quoteTable,
  versionProperty as resolveVersionProperty,
} from "./postgresql-identifiers";

export function compilePostgresqlInsert<TEntity extends object>(
  entity: TEntity,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  const entries = withDefaultVersionEntry(
    definedEntries(entity, options).filter(
      ([property, value]) =>
        !resolvePrimaryKeyProperties(options).includes(property) ||
        (value !== null && value !== undefined),
    ),
    options,
  );

  if (entries.length === 0) {
    throw new Error("Cannot insert an entity without values.");
  }

  const columnValues = expandColumnValues(entries, options);
  const columns = columnValues.map((entry) => entry.column);
  const values = columnValues.map((entry) => entry.value);
  const placeholders = values.map((_, index) => `$${index + 1}`);

  return {
    text: `INSERT INTO ${quoteTable(options)} (${columns.join(
      ", ",
    )}) VALUES (${placeholders.join(", ")}) RETURNING *`,
    values,
  };
}

export function compilePostgresqlUpdate<TEntity extends object>(
  id: unknown,
  patch: TEntity,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  assertId(id);

  const primaryKeys = resolvePrimaryKeyProperties(options);
  const version = resolveVersionProperty(options);
  const entries = definedEntries(patch, options).filter(
    ([property]) => !primaryKeys.includes(property) && property !== version,
  );

  if (entries.length === 0) {
    throw new Error("Cannot update an entity without changed values.");
  }

  const columnValues = expandColumnValues(entries, options);
  const values = columnValues.map((entry) => entry.value);
  const assignments = columnValues.map(
    (entry, index) => `${entry.column} = $${index + 1}`,
  );
  const where = compileIdWhere(id, options, values);

  return {
    text: `UPDATE ${quoteTable(options)} SET ${assignments.join(
      ", ",
    )} WHERE ${where} RETURNING *`,
    values,
  };
}

export function compilePostgresqlVersionedUpdate<TEntity extends object>(
  id: unknown,
  patch: TEntity,
  expectedVersion: unknown,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  assertId(id);
  assertVersion(expectedVersion);

  const primaryKeys = resolvePrimaryKeyProperties(options);
  const version = requireVersionProperty(options);
  const entries = definedEntries(patch, options).filter(
    ([property]) => !primaryKeys.includes(property) && property !== version,
  );

  if (entries.length === 0) {
    throw new Error("Cannot update an entity without changed values.");
  }

  const columnValues = expandColumnValues(entries, options);
  const values = columnValues.map((entry) => entry.value);
  const assignments = columnValues.map(
    (entry, index) => `${entry.column} = $${index + 1}`,
  );
  const versionColumn = propertyToColumns(version, options)[0];
  assignments.push(`${versionColumn} = ${versionColumn} + 1`);
  const where = compileIdWhere(id, options, values);
  values.push(expectedVersion);

  return {
    text: `UPDATE ${quoteTable(options)} SET ${assignments.join(
      ", ",
    )} WHERE ${where} AND ${versionColumn} = $${values.length} RETURNING *`,
    values,
  };
}

export function compilePostgresqlDeleteById(
  id: unknown,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  assertId(id);
  const values: unknown[] = [];

  return {
    text: `DELETE FROM ${quoteTable(options)} WHERE ${compileIdWhere(id, options, values)}`,
    values,
  };
}

export function compilePostgresqlFindById(
  id: unknown,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  assertId(id);
  const values: unknown[] = [];

  return {
    text: `SELECT * FROM ${quoteTable(options)} WHERE ${compileIdWhere(id, options, values)} LIMIT 1`,
    values,
  };
}

export function compilePostgresqlExistsById(
  id: unknown,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  assertId(id);
  const values: unknown[] = [];

  return {
    text: `SELECT EXISTS(SELECT 1 FROM ${quoteTable(
      options,
    )} WHERE ${compileIdWhere(id, options, values)}) AS "exists"`,
    values,
  };
}

export function compilePostgresqlFindAll(
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  return {
    text: `SELECT * FROM ${quoteTable(options)}`,
    values: [],
  };
}

export function compilePostgresqlCount(
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  return {
    text: `SELECT COUNT(*)::int AS "count" FROM ${quoteTable(options)}`,
    values: [],
  };
}

export function compilePostgresqlDeleteAll(
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  return {
    text: `DELETE FROM ${quoteTable(options)}`,
    values: [],
  };
}

export function primaryKeyProperty(
  options: PostgresqlQueryCompilerOptions,
): string {
  return resolvePrimaryKeyProperty(options);
}

export function getPrimaryKeyValue<TEntity extends object>(
  entity: TEntity,
  options: PostgresqlQueryCompilerOptions,
): unknown {
  const record = entity as Record<string, unknown>;
  const primaryKeys = resolvePrimaryKeyProperties(options);

  if (primaryKeys.length === 1) {
    return record[primaryKeys[0]];
  }

  const entries = primaryKeys.map((property) => [property, record[property]] as const);
  return entries.some(([, value]) => value === null || value === undefined)
    ? undefined
    : Object.fromEntries(entries);
}

function expandColumnValues(
  entries: Array<[string, unknown]>,
  options: PostgresqlQueryCompilerOptions,
): Array<{ column: string; value: unknown }> {
  return entries.flatMap(([property, value]) => {
    const columns = propertyToColumns(property, options);
    const values = normalizePropertyValues(property, value, options);

    return columns.map((column, index) => ({
      column,
      value: values[index],
    }));
  });
}

function withDefaultVersionEntry(
  entries: Array<[string, unknown]>,
  options: PostgresqlQueryCompilerOptions,
): Array<[string, unknown]> {
  const version = resolveVersionProperty(options);

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

function requireVersionProperty(
  options: PostgresqlQueryCompilerOptions,
): string {
  const version = resolveVersionProperty(options);

  if (!version) {
    throw new Error("A @Version column is required for versioned updates.");
  }

  return version;
}

function assertVersion(version: unknown): void {
  if (version === null || version === undefined) {
    throw new Error("Version value is required.");
  }
}

function compileIdWhere(
  id: unknown,
  options: PostgresqlQueryCompilerOptions,
  values: unknown[],
): string {
  return primaryKeyValueEntries(id, options).map(([property, value]) => {
    values.push(value);
    return `${propertyToColumns(property, options)[0]} = $${values.length}`;
  }).join(" AND ");
}

function primaryKeyValueEntries(
  id: unknown,
  options: PostgresqlQueryCompilerOptions,
): Array<[string, unknown]> {
  const primaryKeys = resolvePrimaryKeyProperties(options);

  if (primaryKeys.length === 1) {
    assertId(id);
    return [[primaryKeys[0], id]];
  }

  if (id === null || id === undefined || typeof id !== "object") {
    throw new Error("Composite primary key value must be an object.");
  }

  const record = id as Record<string, unknown>;
  return primaryKeys.map((property) => {
    const value = record[property];
    assertId(value);
    return [property, value];
  });
}

function definedEntries<TEntity extends object>(
  entity: TEntity,
  options: PostgresqlQueryCompilerOptions,
): Array<[string, unknown]> {
  const allowedProperties = entityColumnProperties(options);
  return Object.entries(entity).filter(([property, value]) => {
    if (value === undefined) {
      return false;
    }

    return allowedProperties ? allowedProperties.includes(property) : true;
  });
}

function assertId(id: unknown): void {
  if (id === null || id === undefined) {
    throw new Error("Primary key value is required.");
  }
}
