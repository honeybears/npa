import {
  AbstractTransactionManager,
  NPATransactionIsolation,
  NPATransactionOptions,
} from "@honeybeaers/npa";
import { PostgresqlDriverConnection } from "./postgresql-connection";
import { PostgresqlQueryable, PostgresqlQueryResult } from "./types";

export interface PostgresqlTransactionConnection
  extends PostgresqlDriverConnection {
  connect?(): Promise<PostgresqlTransactionConnection>;
}

export class PostgresqlTransactionManager extends AbstractTransactionManager<PostgresqlTransactionConnection> {
  readonly queryable: PostgresqlQueryable = {
    query: <TRow = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<PostgresqlQueryResult<TRow>> | PostgresqlQueryResult<TRow> =>
      this.currentConnection().query<TRow>(text, values),
  };

  constructor(private readonly connection: PostgresqlTransactionConnection) {
    super();
  }

  protected async acquireTransactionResource(): Promise<PostgresqlTransactionConnection> {
    return this.connection.connect ? await this.connection.connect() : this.connection;
  }

  protected beginTransaction(
    resource: PostgresqlTransactionConnection,
    options: NPATransactionOptions,
  ): Promise<void> | void {
    return voidQuery(resource.query(renderBeginStatement(options)));
  }

  protected commitTransaction(
    resource: PostgresqlTransactionConnection,
  ): Promise<void> | void {
    return voidQuery(resource.query("COMMIT"));
  }

  protected rollbackTransaction(
    resource: PostgresqlTransactionConnection,
  ): Promise<void> | void {
    return voidQuery(resource.query("ROLLBACK"));
  }

  protected releaseTransactionResource(
    resource: PostgresqlTransactionConnection,
  ): void {
    if (resource !== this.connection) {
      resource.release?.();
    }
  }

  private currentConnection(): PostgresqlTransactionConnection {
    return this.getCurrentTransactionResource() ?? this.connection;
  }
}

function renderBeginStatement(options: NPATransactionOptions): string {
  const modes = [
    options.isolation ? `ISOLATION LEVEL ${renderIsolation(options.isolation)}` : undefined,
    options.readOnly ? "READ ONLY" : undefined,
  ].filter((mode): mode is string => !!mode);

  return modes.length ? `BEGIN ${modes.join(", ")}` : "BEGIN";
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

async function voidQuery(
  result: Promise<PostgresqlQueryResult> | PostgresqlQueryResult,
): Promise<void> {
  await result;
}
