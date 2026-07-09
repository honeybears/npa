import {
  executeNPAQueryOperation,
  NPAOperationsOptions,
} from "@node-persistence-api/core/adapter";
import {
  MysqlQueryable,
  MysqlRawQueryResult,
} from "./types";

export function instrumentMysqlQueryable(
  queryable: MysqlQueryable,
  operations: NPAOperationsOptions | undefined,
): MysqlQueryable {
  return {
    execute: queryable.execute
      ? <TRow = Record<string, unknown>>(
          text: string,
          values: unknown[] = [],
        ): Promise<MysqlRawQueryResult<TRow>> =>
          executeNPAQueryOperation({
            adapter: "mysql",
            execute: () => queryable.execute?.<TRow>(text, values) as MysqlRawQueryResult<TRow>,
            operations,
            resultMetadata: mysqlResultMetadata,
            text,
            values,
          })
      : undefined,

    query: queryable.query
      ? <TRow = Record<string, unknown>>(
          text: string,
          values: unknown[] = [],
        ): Promise<MysqlRawQueryResult<TRow>> =>
          executeNPAQueryOperation({
            adapter: "mysql",
            execute: () => queryable.query?.<TRow>(text, values) as MysqlRawQueryResult<TRow>,
            operations,
            resultMetadata: mysqlResultMetadata,
            text,
            values,
          })
      : undefined,
  };
}

function mysqlResultMetadata<TRow>(result: MysqlRawQueryResult<TRow>) {
  if (Array.isArray(result)) {
    const [rowsOrPacket] = result;

    if (Array.isArray(rowsOrPacket)) {
      return { rowCount: rowsOrPacket.length };
    }

    return {
      affectedRows: rowsOrPacket.affectedRows,
    };
  }

  return {
    affectedRows: result.affectedRows,
    rowCount: result.rows.length,
  };
}
