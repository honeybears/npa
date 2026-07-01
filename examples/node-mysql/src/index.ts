import { createNPA } from "@honeybeaers/npa";
import {
  MysqlConnection,
  mysql,
  type MysqlDriverConnection,
  type MysqlQueryable,
  type MysqlRawQueryResult,
} from "@honeybeaers/npa-mysql";
import { UserRepository } from "./user.entity";

interface CloseableMysqlQueryable extends MysqlQueryable {
  close(): Promise<void>;
}

async function main(): Promise<void> {
  const connection = await createConnection();
  const npa = createNPA({
    adapter: mysql({ queryable: connection, preferExecute: true }),
    repositories: [UserRepository],
  });
  const users = npa.get(UserRepository);

  console.log("findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc");
  console.log(
    await users.findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc(
      "KIM",
    ),
  );

  console.log("findTopByEmailAllIgnoreCase");
  console.log(await users.findTopByEmailAllIgnoreCase("KIM@EXAMPLE.COM"));

  console.log("existsByEmailIgnoreCase");
  console.log(await users.existsByEmailIgnoreCase("KIM@EXAMPLE.COM"));

  console.log("countDistinctByEmailIgnoreCase");
  console.log(await users.countDistinctByEmailIgnoreCase("KIM@EXAMPLE.COM"));

  await connection.close();
}

async function createConnection(): Promise<CloseableMysqlQueryable> {
  if (process.env.DATABASE_URL) {
    const mysql2 = await importDriver("mysql2/promise") as {
      createPool(url: string): MysqlDriverConnection;
    };

    return new MysqlConnection(mysql2.createPool(process.env.DATABASE_URL));
  }

  return new LoggingMysqlQueryable();
}

function importDriver(specifier: string): Promise<unknown> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (value: string) => Promise<unknown>;

  return dynamicImport(specifier);
}

class LoggingMysqlQueryable implements CloseableMysqlQueryable {
  async query<TRow = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<MysqlRawQueryResult<TRow>> {
    console.log("[mysql sql]", text);
    console.log("[mysql values]", values);

    if (text.startsWith("SELECT EXISTS")) {
      return [[{ exists: 1 } as TRow], []];
    }

    if (text.startsWith("SELECT COUNT")) {
      return [[{ count: 1 } as TRow], []];
    }

    return [[
      {
        id: 1,
        name: "Kim",
        email: "kim@example.com",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      } as TRow,
    ], []];
  }

  execute<TRow = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<MysqlRawQueryResult<TRow>> {
    return this.query(text, values);
  }

  async close(): Promise<void> {}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
