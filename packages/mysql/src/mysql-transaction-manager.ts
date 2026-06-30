import {
  AbstractTransactionManager,
  NPATransactionIsolation,
  NPATransactionOptions,
} from "@honeybeaers/npa";
import { MysqlDriverConnection } from "./mysql-connection";
import { MysqlQueryable, MysqlRawQueryResult } from "./types";

export interface MysqlTransactionConnection extends MysqlDriverConnection {
  getConnection?(): Promise<MysqlTransactionConnection>;
  release?(): void;
}

export class MysqlTransactionManager extends AbstractTransactionManager<MysqlTransactionConnection> {
  readonly queryable: MysqlQueryable = {
    query: <TRow = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow> =>
      query(this.currentConnection(), text, values),
    execute: <TRow = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow> =>
      execute(this.currentConnection(), text, values),
  };

  constructor(private readonly connection: MysqlTransactionConnection) {
    super();
  }

  protected async acquireTransactionResource(): Promise<MysqlTransactionConnection> {
    return this.connection.getConnection
      ? await this.connection.getConnection()
      : this.connection;
  }

  async beginTransaction(
    resource: MysqlTransactionConnection,
    options: NPATransactionOptions,
  ): Promise<void> {
    if (options.isolation) {
      await query(resource, `SET TRANSACTION ISOLATION LEVEL ${renderIsolation(options.isolation)}`);
    }

    await query(resource, renderStartTransactionStatement(options));
  }

  async commitTransaction(resource: MysqlTransactionConnection): Promise<void> {
    await query(resource, "COMMIT");
  }

  async rollbackTransaction(resource: MysqlTransactionConnection): Promise<void> {
    await query(resource, "ROLLBACK");
  }

  protected releaseTransactionResource(resource: MysqlTransactionConnection): void {
    if (resource !== this.connection) {
      resource.release?.();
    }
  }

  private currentConnection(): MysqlTransactionConnection {
    return this.getCurrentTransactionResource() ?? this.connection;
  }
}

function renderStartTransactionStatement(options: NPATransactionOptions): string {
  return options.readOnly ? "START TRANSACTION READ ONLY" : "START TRANSACTION";
}

function renderIsolation(isolation: NPATransactionIsolation): string {
  switch (isolation) {
    case NPATransactionIsolation.READ_UNCOMMITTED:
      return "READ UNCOMMITTED";
    case NPATransactionIsolation.READ_COMMITTED:
      return "READ COMMITTED";
    case NPATransactionIsolation.REPEATABLE_READ:
      return "REPEATABLE READ";
    case NPATransactionIsolation.SERIALIZABLE:
      return "SERIALIZABLE";
  }
}

function query<TRow = Record<string, unknown>>(
  connection: MysqlTransactionConnection,
  text: string,
  values?: unknown[],
): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow> {
  if (connection.query) {
    return connection.query<TRow>(text, values);
  }

  if (connection.execute) {
    return connection.execute<TRow>(text, values);
  }

  throw new Error("MySQL transaction connection requires query() or execute().");
}

function execute<TRow = Record<string, unknown>>(
  connection: MysqlTransactionConnection,
  text: string,
  values?: unknown[],
): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow> {
  if (connection.execute) {
    return connection.execute<TRow>(text, values);
  }

  return query<TRow>(connection, text, values);
}
