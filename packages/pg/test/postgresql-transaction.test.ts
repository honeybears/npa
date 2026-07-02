import { TransactionIsolation } from "../../../src";
import { PostgresqlTransactionManager, type PostgresqlTransactionConnection } from "../src";
import { describe, expect, test } from "@jest/globals";

type RecordedCall = Record<string, unknown>;

describe("PostgreSQL transaction manager", () => {
  test("routes PostgreSQL queries through a transaction client", async () => {
    const calls = [];
    const txClient = createClient("tx", calls);
    const pool = {
      query(text, values) {
        calls.push({ target: "pool", text, values });
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        calls.push({ target: "pool", text: "connect" });
        return txClient;
      },
    };
    const manager = new PostgresqlTransactionManager(
      pool as unknown as PostgresqlTransactionConnection,
    );

    await manager.queryable.query("SELECT outside", [1]);
    await manager.transactional(async () => {
      expect(manager.isTransactionActive()).toEqual(true);
      await manager.queryable.query("INSERT inside", [2]);
    });

    expect(manager.isTransactionActive()).toEqual(false);
    expect(calls).toEqual([
      { target: "pool", text: "SELECT outside", values: [1] },
      { target: "pool", text: "connect" },
      { target: "tx", text: "BEGIN", values: undefined },
      { target: "tx", text: "INSERT inside", values: [2] },
      { target: "tx", text: "COMMIT", values: undefined },
      { target: "tx", text: "release" },
    ]);
  });

  test("rolls back PostgreSQL transactions and renders transaction options", async () => {
    const calls = [];
    const txClient = createClient("tx", calls);
    const pool = {
      async connect() {
        calls.push({ target: "pool", text: "connect" });
        return txClient;
      },
    };
    const manager = new PostgresqlTransactionManager(
      pool as unknown as PostgresqlTransactionConnection,
    );

    await expect(
      manager.transactional(
        async () => {
          await manager.queryable.query("UPDATE inside", [3]);
          throw new Error("fail");
        },
        { isolation: TransactionIsolation.SERIALIZABLE, readOnly: true },
      ),
    ).rejects.toThrow(/fail/);

    expect(calls).toEqual([
      { target: "pool", text: "connect" },
      {
        target: "tx",
        text: "BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY",
        values: undefined,
      },
      { target: "tx", text: "UPDATE inside", values: [3] },
      { target: "tx", text: "ROLLBACK", values: undefined },
      { target: "tx", text: "release" },
    ]);
  });

  test("joins nested required PostgreSQL transactions", async () => {
    const calls = [];
    const txClient = createClient("tx", calls);
    const pool = {
      async connect() {
        calls.push({ target: "pool", text: "connect" });
        return txClient;
      },
    };
    const manager = new PostgresqlTransactionManager(
      pool as unknown as PostgresqlTransactionConnection,
    );

    await manager.transactional(async () => {
      await manager.transactional(async () => {
        await manager.queryable.query("SELECT nested");
      });
    });

    expect(calls).toEqual([
      { target: "pool", text: "connect" },
      { target: "tx", text: "BEGIN", values: undefined },
      { target: "tx", text: "SELECT nested", values: undefined },
      { target: "tx", text: "COMMIT", values: undefined },
      { target: "tx", text: "release" },
    ]);
  });
});

function createClient(target: string, calls: RecordedCall[]) {
  return {
    query(text, values) {
      calls.push({ target, text, values });
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ target, text: "release" });
    },
  };
}
