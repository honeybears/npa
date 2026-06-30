import { EntityTarget, NPALoadOptions } from "@honeybeaers/npa";

export interface MysqlOkPacket {
  affectedRows?: number;
  insertId?: number | string;
  [key: string]: unknown;
}

export interface MysqlQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  affectedRows?: number;
  insertId?: number | string;
}

export type MysqlRawQueryResult<TRow = Record<string, unknown>> =
  | MysqlQueryResult<TRow>
  | [TRow[] | MysqlOkPacket, unknown];

export interface MysqlQueryable {
  query?<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow>;
  execute?<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow>;
}

export interface MysqlQueryCompilerOptions {
  entity?: EntityTarget;
  tableName?: string;
  schema?: string;
  columns?: Record<string, string>;
  primaryKey?: string;
}

export interface MysqlRepositoryOptions extends MysqlQueryCompilerOptions {
  queryable: MysqlQueryable;
  preferExecute?: boolean;
}

export type MysqlFindOptions<TEntity extends object = object> =
  NPALoadOptions<TEntity>;

export interface MysqlCompiledQuery {
  text: string;
  values: unknown[];
}
