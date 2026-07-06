import {
  PostgresqlQueryable,
  PostgresqlQueryResult,
} from "./types";
import { toPostgresqlDatabaseError } from "./postgresql-database-error";

export interface PostgresqlDriverConnection {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresqlQueryResult<TRow>> | PostgresqlQueryResult<TRow>;
  end?(): Promise<void> | void;
  release?(): void;
  connect?(): Promise<PostgresqlDriverConnection>;
}

export class PostgresqlConnection implements PostgresqlQueryable {
  constructor(private readonly connection: PostgresqlDriverConnection) {}

  async query<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresqlQueryResult<TRow>> {
    try {
      return await this.connection.query<TRow>(text, values);
    } catch (error) {
      throw toPostgresqlDatabaseError(error);
    }
  }

  async close(): Promise<void> {
    if (this.connection.end) {
      await this.connection.end();
      return;
    }

    this.connection.release?.();
  }
}
