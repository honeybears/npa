import { NPADatabaseError } from "@node-persistence-api/core";
import {
  MysqlQueryable,
  MysqlRawQueryResult,
} from "./types";
import { toMysqlDatabaseError } from "./mysql-database-error";

export interface MysqlDriverConnection {
  query?<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow>;
  execute?<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<MysqlRawQueryResult<TRow>> | MysqlRawQueryResult<TRow>;
  end?(): Promise<void> | void;
  release?(): void;
  getConnection?(): Promise<MysqlDriverConnection>;
}

export class MysqlConnection implements MysqlQueryable {
  constructor(private readonly connection: MysqlDriverConnection) {}

  async query<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<MysqlRawQueryResult<TRow>> {
    try {
      if (this.connection.query) {
        return await this.connection.query<TRow>(text, values);
      }

      if (this.connection.execute) {
        return await this.connection.execute<TRow>(text, values);
      }
    } catch (error) {
      throw toMysqlDatabaseError(error);
    }

    throw new NPADatabaseError("MySQL connection requires query() or execute().", {
      code: "NPA_DATABASE_CONNECTION_INVALID",
    });
  }

  async execute<TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<MysqlRawQueryResult<TRow>> {
    try {
      if (this.connection.execute) {
        return await this.connection.execute<TRow>(text, values);
      }

      if (this.connection.query) {
        return await this.connection.query<TRow>(text, values);
      }
    } catch (error) {
      throw toMysqlDatabaseError(error);
    }

    throw new NPADatabaseError("MySQL connection requires query() or execute().", {
      code: "NPA_DATABASE_CONNECTION_INVALID",
    });
  }

  async close(): Promise<void> {
    await this.connection.end?.();
  }
}
