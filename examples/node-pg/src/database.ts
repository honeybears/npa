import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  PostgresqlConnection,
  type PostgresqlDriverConnection,
  type PostgresqlQueryable,
} from "@node-persistence-api/connector-pg";

const execFileAsync = promisify(execFile);

export interface CloseablePostgresqlQueryable extends PostgresqlQueryable {
  close(): Promise<void>;
}

export async function createConnection(): Promise<CloseablePostgresqlQueryable> {
  if (process.env.DATABASE_URL) {
    const { Pool } = await importDriver("pg") as {
      Pool: new (options: { connectionString: string }) => PostgresqlDriverConnection;
    };

    return new PostgresqlConnection(
      new Pool({ connectionString: process.env.DATABASE_URL }),
    );
  }

  const container = await new PostgreSqlContainer(
    process.env.NPA_EXAMPLE_POSTGRESQL_IMAGE ?? "postgres:16-alpine",
  ).start();
  const { Pool } = await importDriver("pg") as {
    Pool: new (options: { connectionString: string }) => PostgresqlDriverConnection;
  };
  const connection = new PostgresqlConnection(
    new Pool({ connectionString: container.getConnectionUri() }),
  );

  try {
    await pushSchema(container.getConnectionUri());
    await seedDatabase(connection);

    return new ContainerPostgresqlConnection(connection, container);
  } catch (error) {
    await connection.close();
    await container.stop();
    throw error;
  }
}

function importDriver(specifier: string): Promise<unknown> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (value: string) => Promise<unknown>;

  return dynamicImport(specifier);
}

async function pushSchema(databaseUrl: string): Promise<void> {
  const cwd = path.resolve(__dirname, "..");
  await execFileAsync(
    process.execPath,
    [path.resolve(cwd, "../../dist/cli/npa.js"), "db", "push", "--config", "npa.config.mjs"],
    {
      cwd,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    },
  );
}

async function seedDatabase(connection: PostgresqlConnection): Promise<void> {
  await connection.query(
    "INSERT INTO users (name, email, created_at) VALUES ($1, $2, $3)",
    ["Kim", "kim@example.com", new Date("2026-01-01T00:00:00.000Z")],
  );
}

class ContainerPostgresqlConnection implements CloseablePostgresqlQueryable {
  constructor(
    private readonly connection: PostgresqlConnection,
    private readonly container: StartedPostgreSqlContainer,
  ) {}

  query: PostgresqlConnection["query"] = (text, values) =>
    this.connection.query(text, values);

  async close(): Promise<void> {
    await this.connection.close();
    await this.container.stop();
  }
}
