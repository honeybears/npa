import {
  PostgresqlCompiledQuery,
  PostgresqlQueryCompilerOptions,
} from "./types";
import {
  entityColumnProperties,
  primaryKeyProperty as resolvePrimaryKeyProperty,
  propertyToColumn,
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
        property !== resolvePrimaryKeyProperty(options) ||
        (value !== null && value !== undefined),
    ),
    options,
  );

  if (entries.length === 0) {
    throw new Error("Cannot insert an entity without values.");
  }

  const columns = entries.map(([property]) => propertyToColumn(property, options));
  const values = entries.map(([, value]) => value);
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

  const primaryKey = resolvePrimaryKeyProperty(options);
  const version = resolveVersionProperty(options);
  const entries = definedEntries(patch, options).filter(
    ([property]) => property !== primaryKey && property !== version,
  );

  if (entries.length === 0) {
    throw new Error("Cannot update an entity without changed values.");
  }

  const values = entries.map(([, value]) => value);
  const assignments = entries.map(
    ([property], index) => `${propertyToColumn(property, options)} = $${index + 1}`,
  );
  values.push(id);

  return {
    text: `UPDATE ${quoteTable(options)} SET ${assignments.join(
      ", ",
    )} WHERE ${propertyToColumn(primaryKey, options)} = $${
      values.length
    } RETURNING *`,
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

  const primaryKey = resolvePrimaryKeyProperty(options);
  const version = requireVersionProperty(options);
  const entries = definedEntries(patch, options).filter(
    ([property]) => property !== primaryKey && property !== version,
  );

  if (entries.length === 0) {
    throw new Error("Cannot update an entity without changed values.");
  }

  const values = entries.map(([, value]) => value);
  const assignments = entries.map(
    ([property], index) => `${propertyToColumn(property, options)} = $${index + 1}`,
  );
  const versionColumn = propertyToColumn(version, options);
  assignments.push(`${versionColumn} = ${versionColumn} + 1`);
  values.push(id, expectedVersion);

  return {
    text: `UPDATE ${quoteTable(options)} SET ${assignments.join(
      ", ",
    )} WHERE ${propertyToColumn(primaryKey, options)} = $${
      values.length - 1
    } AND ${versionColumn} = $${values.length} RETURNING *`,
    values,
  };
}

export function compilePostgresqlDeleteById(
  id: unknown,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  assertId(id);

  return {
    text: `DELETE FROM ${quoteTable(options)} WHERE ${propertyToColumn(
      primaryKeyProperty(options),
      options,
    )} = $1`,
    values: [id],
  };
}

export function compilePostgresqlFindById(
  id: unknown,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  assertId(id);

  return {
    text: `SELECT * FROM ${quoteTable(options)} WHERE ${propertyToColumn(
      primaryKeyProperty(options),
      options,
    )} = $1 LIMIT 1`,
    values: [id],
  };
}

export function compilePostgresqlExistsById(
  id: unknown,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  assertId(id);

  return {
    text: `SELECT EXISTS(SELECT 1 FROM ${quoteTable(
      options,
    )} WHERE ${propertyToColumn(
      primaryKeyProperty(options),
      options,
    )} = $1) AS "exists"`,
    values: [id],
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
  return (entity as Record<string, unknown>)[resolvePrimaryKeyProperty(options)];
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
