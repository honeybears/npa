import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  MySqlContainer,
  type StartedMySqlContainer,
} from "@testcontainers/mysql";
import {
  MysqlConnection,
  type MysqlDriverConnection,
  type MysqlQueryable,
} from "@node-persistence-api/connector-mysql";

const execFileAsync = promisify(execFile);

export interface CloseableMysqlQueryable extends MysqlQueryable {
  close(): Promise<void>;
}

export async function createConnection(): Promise<CloseableMysqlQueryable> {
  if (process.env.DATABASE_URL) {
    const mysql2 = await importDriver("mysql2/promise") as {
      createPool(url: string): MysqlDriverConnection;
    };

    return new MysqlConnection(mysql2.createPool(process.env.DATABASE_URL));
  }

  const container = await new MySqlContainer(
    process.env.NPA_EXAMPLE_MYSQL_IMAGE ?? "mysql:8.0",
  ).start();
  const mysql2 = await importDriver("mysql2/promise") as {
    createPool(url: string): MysqlDriverConnection;
  };
  const connection = new MysqlConnection(
    mysql2.createPool(container.getConnectionUri()),
  );

  try {
    await pushSchema(container.getConnectionUri());
    await seedDatabase(connection);

    return new ContainerMysqlConnection(connection, container);
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

async function seedDatabase(connection: MysqlConnection): Promise<void> {
  await connection.query(
    "INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)",
    ["Kim", "kim@example.com", new Date("2026-01-01T00:00:00.000Z")],
  );
}

class ContainerMysqlConnection implements CloseableMysqlQueryable {
  constructor(
    private readonly connection: MysqlConnection,
    private readonly container: StartedMySqlContainer,
  ) {}

  query: MysqlConnection["query"] = (text, values) =>
    this.connection.query(text, values);

  execute: MysqlConnection["execute"] = (text, values) =>
    this.connection.execute(text, values);

  async close(): Promise<void> {
    await this.connection.close();
    await this.container.stop();
  }
}
