import {
  mysqlEntityColumnProperties,
  normalizeMysqlPropertyValue,
  mysqlPrimaryKeyProperty,
  mysqlPropertyToColumn,
  mysqlVersionProperty,
  quoteMysqlTable,
} from "./mysql-identifiers";
import { MysqlCompiledQuery, MysqlQueryCompilerOptions } from "./types";

export function compileMysqlInsert<TEntity extends object>(
  entity: TEntity,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  const entries = withDefaultVersionEntry(
    definedEntries(entity, options).filter(
      ([property, value]) =>
        property !== mysqlPrimaryKeyProperty(options) ||
        (value !== null && value !== undefined),
    ),
    options,
  );

  if (entries.length === 0) {
    throw new Error("Cannot insert an entity without values.");
  }

  const columns = entries.map(([property]) => mysqlPropertyToColumn(property, options));
  const values = entries.map(([property, value]) => normalizeMysqlPropertyValue(property, value, options));
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

  const primaryKey = mysqlPrimaryKeyProperty(options);
  const version = mysqlVersionProperty(options);
  const entries = definedEntries(patch, options).filter(
    ([property]) => property !== primaryKey && property !== version,
  );

  if (entries.length === 0) {
    throw new Error("Cannot update an entity without changed values.");
  }

  const values = entries.map(([property, value]) => normalizeMysqlPropertyValue(property, value, options));
  const assignments = entries.map(
    ([property]) => `${mysqlPropertyToColumn(property, options)} = ?`,
  );
  values.push(id);

  return {
    text: `UPDATE ${quoteMysqlTable(options)} SET ${assignments.join(
      ", ",
    )} WHERE ${mysqlPropertyToColumn(primaryKey, options)} = ?`,
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

  const primaryKey = mysqlPrimaryKeyProperty(options);
  const version = requireMysqlVersionProperty(options);
  const entries = definedEntries(patch, options).filter(
    ([property]) => property !== primaryKey && property !== version,
  );

  if (entries.length === 0) {
    throw new Error("Cannot update an entity without changed values.");
  }

  const values = entries.map(([property, value]) => normalizeMysqlPropertyValue(property, value, options));
  const assignments = entries.map(
    ([property]) => `${mysqlPropertyToColumn(property, options)} = ?`,
  );
  const versionColumn = mysqlPropertyToColumn(version, options);
  assignments.push(`${versionColumn} = ${versionColumn} + 1`);
  values.push(id, expectedVersion);

  return {
    text: `UPDATE ${quoteMysqlTable(options)} SET ${assignments.join(
      ", ",
    )} WHERE ${mysqlPropertyToColumn(primaryKey, options)} = ? AND ${versionColumn} = ?`,
    values,
  };
}

export function compileMysqlDeleteById(
  id: unknown,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  assertId(id);

  return {
    text: `DELETE FROM ${quoteMysqlTable(options)} WHERE ${mysqlPropertyToColumn(
      mysqlPrimaryKeyProperty(options),
      options,
    )} = ?`,
    values: [id],
  };
}

export function compileMysqlFindById(
  id: unknown,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  assertId(id);

  return {
    text: `SELECT * FROM ${quoteMysqlTable(options)} WHERE ${mysqlPropertyToColumn(
      mysqlPrimaryKeyProperty(options),
      options,
    )} = ? LIMIT 1`,
    values: [id],
  };
}

export function compileMysqlExistsById(
  id: unknown,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  assertId(id);

  return {
    text: `SELECT EXISTS(SELECT 1 FROM ${quoteMysqlTable(
      options,
    )} WHERE ${mysqlPropertyToColumn(
      mysqlPrimaryKeyProperty(options),
      options,
    )} = ?) AS \`exists\``,
    values: [id],
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
  return (entity as Record<string, unknown>)[mysqlPrimaryKeyProperty(options)];
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
    throw new Error("Primary key value is required.");
  }
}
