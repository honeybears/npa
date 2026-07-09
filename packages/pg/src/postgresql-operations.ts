import {
  executeNPAQueryOperation,
  NPAOperationsOptions,
} from "@node-persistence-api/core/adapter";
import {
  PostgresqlQueryable,
  PostgresqlQueryResult,
} from "./types";
import { toPostgresqlDatabaseError } from "./postgresql-database-error";

export function instrumentPostgresqlQueryable(
  queryable: PostgresqlQueryable,
  operations: NPAOperationsOptions | undefined,
): PostgresqlQueryable {
  return {
    query<TRow = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ): Promise<PostgresqlQueryResult<TRow>> {
      return executeNPAQueryOperation({
        adapter: "postgresql",
        execute: () => queryable.query<TRow>(text, values),
        operations,
        resultMetadata: postgresqlResultMetadata,
        text,
        toDatabaseError: toPostgresqlDatabaseError,
        values,
      });
    },
  };
}

function postgresqlResultMetadata<TRow>(
  result: PostgresqlQueryResult<TRow>,
) {
  return {
    rowCount: result.rowCount ?? result.rows.length,
  };
}
