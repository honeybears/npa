import {
  MysqlOkPacket,
  MysqlQueryResult,
  MysqlRawQueryResult,
  MysqlRepositoryOptions,
} from "./types";

export async function executeMysqlQuery<TRow = Record<string, unknown>>(
  options: MysqlRepositoryOptions,
  text: string,
  values: unknown[],
): Promise<MysqlQueryResult<TRow>> {
  const raw = await callQueryable<TRow>(options, text, values);
  return normalizeMysqlResult(raw);
}

function callQueryable<TRow>(
  options: MysqlRepositoryOptions,
  text: string,
  values: unknown[],
): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow> {
  if (options.preferExecute && options.queryable.execute) {
    return options.queryable.execute<TRow>(text, values);
  }

  if (options.queryable.query) {
    return options.queryable.query<TRow>(text, values);
  }

  if (options.queryable.execute) {
    return options.queryable.execute<TRow>(text, values);
  }

  throw new Error("MySQL queryable requires query() or execute().");
}

export function normalizeMysqlResult<TRow>(
  raw: MysqlRawQueryResult<TRow>,
): MysqlQueryResult<TRow> {
  if (Array.isArray(raw)) {
    const [rowsOrPacket] = raw;

    if (Array.isArray(rowsOrPacket)) {
      return { rows: rowsOrPacket as TRow[] };
    }

    const packet = rowsOrPacket as MysqlOkPacket;
    return {
      rows: [],
      affectedRows: packet.affectedRows,
      insertId: packet.insertId,
    };
  }

  return raw;
}
