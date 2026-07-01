import { NPA } from "@honeybeaers/npa";
import "./repositories";
import {
  PostgresqlConnection,
  postgresql,
  type PostgresqlDriverConnection,
  type PostgresqlQueryResult,
  type PostgresqlQueryable,
} from "@honeybeaers/npa-pg";
import { UserRepository } from "./user.entity";

interface CloseablePostgresqlQueryable extends PostgresqlQueryable {
  close(): Promise<void>;
}

async function main(): Promise<void> {
  const connection = await createConnection();
  const npa = new NPA({
    adapter: postgresql({ queryable: connection }),
  });
  const users = npa.get(UserRepository);

  console.log("findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc");
  console.log(
    await users.findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc(
      "KIM",
    ),
  );

  console.log("findFirstByEmailAllIgnoreCase");
  console.log(await users.findFirstByEmailAllIgnoreCase("KIM@EXAMPLE.COM"));

  console.log("existsByEmailIgnoreCase");
  console.log(await users.existsByEmailIgnoreCase("KIM@EXAMPLE.COM"));

  console.log("countDistinctByEmailIgnoreCase");
  console.log(await users.countDistinctByEmailIgnoreCase("KIM@EXAMPLE.COM"));

  await connection.close();
}

async function createConnection(): Promise<CloseablePostgresqlQueryable> {
  if (process.env.DATABASE_URL) {
    const { Pool } = await importDriver("pg") as {
      Pool: new (options: { connectionString: string }) => PostgresqlDriverConnection;
    };

    return new PostgresqlConnection(
      new Pool({ connectionString: process.env.DATABASE_URL }),
    );
  }

  return new LoggingPostgresqlQueryable();
}

function importDriver(specifier: string): Promise<unknown> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (value: string) => Promise<unknown>;

  return dynamicImport(specifier);
}

class LoggingPostgresqlQueryable implements CloseablePostgresqlQueryable {
  async query<TRow = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresqlQueryResult<TRow>> {
    console.log("[pg sql]", text);
    console.log("[pg values]", values);

    if (text.startsWith("SELECT EXISTS")) {
      return { rows: [{ exists: true } as TRow], rowCount: 1 };
    }

    if (text.startsWith("SELECT COUNT")) {
      return { rows: [{ count: 1 } as TRow], rowCount: 1 };
    }

    return {
      rows: [
        {
          id: 1,
          name: "Kim",
          email: "kim@example.com",
          created_at: new Date("2026-01-01T00:00:00.000Z"),
        } as TRow,
      ],
      rowCount: 1,
    };
  }

  async close(): Promise<void> {}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
