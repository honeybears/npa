import { NPATransactionIsolation } from "../../../dist";
import { MysqlTransactionManager, type MysqlTransactionConnection } from "../dist";
import { describe, expect, test } from "@jest/globals";

type RecordedCall = Record<string, unknown>;

describe("MySQL transaction manager", () => {
  test("routes MySQL queries through a transaction connection", async () => {
    const calls = [];
    const txConnection = createConnection("tx", calls);
    const pool = {
      query(text, values) {
        calls.push({ method: "query", target: "pool", text, values });
        return [[], []];
      },
      async getConnection() {
        calls.push({ target: "pool", text: "getConnection" });
        return txConnection;
      },
    };
    const manager = new MysqlTransactionManager(
      pool as unknown as MysqlTransactionConnection,
    );

    await manager.queryable.query("SELECT outside", [1]);
    await manager.transactional(async () => {
      expect(manager.isTransactionActive()).toEqual(true);
      await manager.queryable.execute("INSERT inside", [2]);
    });

    expect(manager.isTransactionActive()).toEqual(false);
    expect(calls).toEqual([
      { method: "query", target: "pool", text: "SELECT outside", values: [1] },
      { target: "pool", text: "getConnection" },
      { method: "query", target: "tx", text: "START TRANSACTION", values: undefined },
      { method: "execute", target: "tx", text: "INSERT inside", values: [2] },
      { method: "query", target: "tx", text: "COMMIT", values: undefined },
      { target: "tx", text: "release" },
    ]);
  });

  test("rolls back MySQL transactions and renders transaction options", async () => {
    const calls = [];
    const txConnection = createConnection("tx", calls);
    const pool = {
      async getConnection() {
        calls.push({ target: "pool", text: "getConnection" });
        return txConnection;
      },
    };
    const manager = new MysqlTransactionManager(
      pool as unknown as MysqlTransactionConnection,
    );

    await expect(
      manager.transactional(
        async () => {
          await manager.queryable.query("UPDATE inside", [3]);
          throw new Error("fail");
        },
        { isolation: NPATransactionIsolation.REPEATABLE_READ, readOnly: true },
      ),
    ).rejects.toThrow(/fail/);

    expect(calls).toEqual([
      { target: "pool", text: "getConnection" },
      {
        method: "query",
        target: "tx",
        text: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        values: undefined,
      },
      {
        method: "query",
        target: "tx",
        text: "START TRANSACTION READ ONLY",
        values: undefined,
      },
      { method: "query", target: "tx", text: "UPDATE inside", values: [3] },
      { method: "query", target: "tx", text: "ROLLBACK", values: undefined },
      { target: "tx", text: "release" },
    ]);
  });

  test("joins nested required MySQL transactions", async () => {
    const calls = [];
    const txConnection = createConnection("tx", calls);
    const pool = {
      async getConnection() {
        calls.push({ target: "pool", text: "getConnection" });
        return txConnection;
      },
    };
    const manager = new MysqlTransactionManager(
      pool as unknown as MysqlTransactionConnection,
    );

    await manager.transactional(async () => {
      await manager.transactional(async () => {
        await manager.queryable.query("SELECT nested");
      });
    });

    expect(calls).toEqual([
      { target: "pool", text: "getConnection" },
      { method: "query", target: "tx", text: "START TRANSACTION", values: undefined },
      { method: "query", target: "tx", text: "SELECT nested", values: undefined },
      { method: "query", target: "tx", text: "COMMIT", values: undefined },
      { target: "tx", text: "release" },
    ]);
  });
});

function createConnection(target: string, calls: RecordedCall[]) {
  return {
    query(text, values) {
      calls.push({ method: "query", target, text, values });
      return [[], []];
    },
    execute(text, values) {
      calls.push({ method: "execute", target, text, values });
      return [[], []];
    },
    release() {
      calls.push({ target, text: "release" });
    },
  };
}
