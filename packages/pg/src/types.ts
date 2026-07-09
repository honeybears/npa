import { EntityTarget, CursorQueryMetadata, NPALoadOptions, NPAOperationsOptions } from "@node-persistence-api/core/adapter";

export interface PostgresqlQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  rowCount?: number | null;
}

export interface PostgresqlQueryable {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresqlQueryResult<TRow>> | PostgresqlQueryResult<TRow>;
}

export interface PostgresqlQueryCompilerOptions {
  entity?: EntityTarget;
  tableName?: string;
  schema?: string;
  columns?: Record<string, string>;
  primaryKey?: string;
}

export interface PostgresqlRepositoryOptions
  extends PostgresqlQueryCompilerOptions {
  operations?: NPAOperationsOptions;
  queryable: PostgresqlQueryable;
}

export type PostgresqlFindOptions<TEntity extends object = object> =
  NPALoadOptions<TEntity>;

export interface PostgresqlCompiledQuery {
  text: string;
  values: unknown[];
  cursor?: CursorQueryMetadata;
}
