import * as mysql from "mysql2/promise";
import { Pool } from "pg";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Column, Entity, Id, Pageable, Version } from "../../src";
import { PostgresqlConnection, PostgresqlTransactionManager, createPostgresqlDerivedQueryRepository } from "../../packages/pg/src";
import { MysqlConnection, MysqlTransactionManager, createMysqlDerivedQueryRepository, type MysqlTransactionConnection } from "../../packages/mysql/src";
import { expect } from "@jest/globals";

const POSTGRESQL_IMAGE =
  process.env.NPA_E2E_POSTGRESQL_IMAGE ?? "postgres:16-alpine";
const MYSQL_IMAGE = process.env.NPA_E2E_MYSQL_IMAGE ?? "mysql:8.0";

type StartedDatabaseContainer = {
  getConnectionUri(): string;
  stop(): Promise<unknown> | unknown;
};

type DatabaseFlowContext = {
  adapter: any;
  container: StartedDatabaseContainer;
  queryable: any;
  tableName: string;
};

type DatabaseFlow = (context: DatabaseFlowContext) => Promise<void> | void;

const databaseAdapters = [
  {
    name: "PostgreSQL",
    adapterName: "postgresql",
    tablePrefix: "postgresql",
    createContainer: () => new PostgreSqlContainer(POSTGRESQL_IMAGE),
    quoteIdentifier: quotePostgresqlIdentifier,
    createQueryable: async (container) =>
      new PostgresqlConnection(
        new Pool({ connectionString: container.getConnectionUri() }),
      ),
    createTransactionRuntime: (container) => {
      const pool = new Pool({ connectionString: container.getConnectionUri() });
      const manager = new PostgresqlTransactionManager(pool);

      return {
        manager,
        queryable: manager.queryable,
        close: () => pool.end(),
      };
    },
    closeQueryable: (connection) => connection.close(),
    executeSql: (connection, sql) => connection.query(sql),
    readTransactionIsolation: async (queryable) => {
      const result = await queryable.query("SHOW transaction_isolation");
      return result.rows[0].transaction_isolation;
    },
    createTableSql: (table) => `
      CREATE TABLE ${table} (
        product_id SERIAL PRIMARY KEY,
        product_name TEXT NOT NULL,
        price INTEGER NOT NULL,
        active BOOLEAN NOT NULL,
        status TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        version INTEGER NOT NULL
      )
    `,
    createRepository: ({ entity, queryable }) =>
      createPostgresqlDerivedQueryRepository(
        {},
        {
          entity,
          queryable,
        },
      ),
  },
  {
    name: "MySQL",
    adapterName: "mysql",
    tablePrefix: "mysql",
    createContainer: () => new MySqlContainer(MYSQL_IMAGE),
    quoteIdentifier: quoteMysqlIdentifier,
    createQueryable: (container) =>
      createMysqlConnection(container.getConnectionUri()),
    createTransactionRuntime: (container) =>
      createMysqlTransactionRuntime(container.getConnectionUri()),
    closeQueryable: (connection) => connection.close(),
    executeSql: (connection, sql) => connection.query(sql),
    createTableSql: (table) => `
      CREATE TABLE ${table} (
        product_id INT AUTO_INCREMENT PRIMARY KEY,
        product_name VARCHAR(255) NOT NULL,
        price INT NOT NULL,
        active BOOLEAN NOT NULL,
        status VARCHAR(64),
        created_at DATETIME(3) NOT NULL,
        version INT NOT NULL
      )
    `,
    createRepository: ({ entity, queryable }) =>
      createMysqlDerivedQueryRepository(
        {},
        {
          entity,
          queryable,
        },
      ),
  },
];

async function runDatabaseFlow(adapter: any, flow: DatabaseFlow) {
  const tableName = uniqueTableName(adapter.tablePrefix);
  const table = adapter.quoteIdentifier(tableName);
  const container = await startContainerOrSkip(adapter.createContainer());

  if (!container) {
    return;
  }

  let queryable;

  try {
    queryable = await adapter.createQueryable(container);
    await adapter.executeSql(queryable, adapter.createTableSql(table));

    await flow({
      adapter,
      container,
      queryable,
      tableName,
    });
  } finally {
    try {
      if (queryable) {
        await closeQueryable(adapter, queryable, table);
      }
    } finally {
      await container.stop();
    }
  }
}

async function assertRepositoryContract(
  repository,
  options: { nullableStatus?: boolean } = {},
) {
  const first = await repository.insert({
    name: "desk alpha",
    price: 120,
    active: true,
    status: "draft",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const firstId = first.product_id;

  expect(typeof firstId).toEqual("number");
  expect(first.product_name).toEqual("desk alpha");
  expect(first.price).toEqual(120);
  expect(first.version).toEqual(0);
  expect(await repository.existsById(firstId)).toEqual(true);
  expect(await repository.existsById(firstId + 1000)).toEqual(false);
  expect(await repository.findById(firstId)).toEqual(first);
  expect(await repository.findById(firstId + 1000)).toEqual(null);
  expect(await repository.findOneByName("missing product")).toEqual(null);
  expect(await repository.deleteByStatus("missing")).toEqual(0);

  const updated = await repository.updateById(firstId, {
    name: "desk beta",
    price: 150,
    active: true,
    status: "published",
  });

  expect(updated.product_id).toEqual(firstId);
  expect(updated.product_name).toEqual("desk beta");
  expect(updated.price).toEqual(150);
  expect(updated.status).toEqual("published");

  await repository.insert({
    name: "chair beta",
    price: 80,
    active: false,
    status: "draft",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  await repository.insert({
    name: "desk gamma",
    price: 300,
    active: true,
    status: "archived",
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
  });

  expect(await repository.count()).toEqual(3);
  expect((await repository.findAll()).map((row) => row.product_name).sort()).toEqual(["chair beta", "desk beta", "desk gamma"]);
  expect((await repository.findAll({
    orderBy: [{ property: "createdAt", direction: "desc" }],
  })).map((row) => row.product_name)).toEqual([
    "desk gamma",
    "chair beta",
    "desk beta",
  ]);

  const projection = await repository.findAll({
    select: ["id", "name"],
    orderBy: [{ property: "name", direction: "asc" }],
  });
  expect(projection).toEqual([
    { id: expect.any(Number), name: "chair beta" },
    { id: expect.any(Number), name: "desk beta" },
    { id: expect.any(Number), name: "desk gamma" },
  ]);

  const projectionPage = await repository.findAll({
    select: ["id", "name"],
    orderBy: [{ property: "name", direction: "asc" }],
    pageable: Pageable.offset(0, 2),
  });
  expect(projectionPage.content).toEqual([
    { id: expect.any(Number), name: "chair beta" },
    { id: expect.any(Number), name: "desk beta" },
  ]);
  expect(projectionPage.totalElements).toEqual(3);

  const projectionCursorPage = await repository.findAll({
    select: ["name"],
    orderBy: [{ property: "name", direction: "asc" }],
    pageable: Pageable.cursor({ size: 2 }),
  });
  expect(projectionCursorPage.content).toEqual([
    { name: "chair beta" },
    { name: "desk beta" },
  ]);
  expect(projectionCursorPage.nextCursor).toEqual(expect.any(String));

  const nextProjectionCursorPage = await repository.findAll({
    select: ["name"],
    orderBy: [{ property: "name", direction: "asc" }],
    pageable: Pageable.cursor({
      after: projectionCursorPage.nextCursor!,
      size: 2,
    }),
  });
  expect(nextProjectionCursorPage.content).toEqual([
    { name: "desk gamma" },
  ]);

  const desks =
    await repository.findTop2ByNameContainingAndPriceGreaterThanOrderByCreatedAtDesc(
      "desk",
      100,
    );
  expect(desks.map((row) => row.product_name)).toEqual(["desk gamma", "desk beta"]);

  expect(await repository.existsByActiveTrueAndStatus("published")).toEqual(true);
  expect(await repository.existsByActiveFalse()).toEqual(true);
  expect(await repository.countByPriceBetween(100, 300)).toEqual(2);
  expect(await repository.deleteByStatusIn(["archived", "draft"])).toEqual(2);
  expect(await repository.countByPriceGreaterThan(0)).toEqual(1);
  expect(await repository.deleteById(firstId)).toEqual(1);
  expect(await repository.countByPriceGreaterThan(0)).toEqual(0);
  await repository.insert({
    name: "floor lamp",
    price: 40,
    active: true,
    status: "draft",
    createdAt: new Date("2026-01-04T00:00:00.000Z"),
  });
  expect(await repository.deleteAll()).toEqual(1);
  expect(await repository.count()).toEqual(0);

  if (options.nullableStatus) {
    await assertNullableStatusContract(repository);
  }
}

async function assertNullableStatusContract(repository) {
  await repository.insert({
    name: "null status",
    price: 50,
    active: true,
    status: null,
    createdAt: new Date("2026-01-05T00:00:00.000Z"),
  });
  await repository.insert({
    name: "active status",
    price: 60,
    active: true,
    status: "active",
    createdAt: new Date("2026-01-06T00:00:00.000Z"),
  });

  expect((await repository.findByStatus(null)).map((row) => row.product_name)).toEqual(["null status"]);
  expect((await repository.findByStatusIsNull()).map((row) => row.product_name)).toEqual(["null status"]);
  await expect(repository.findByStatusIn([])).rejects.toThrow(
    /expects a non-empty array parameter/,
  );
  await expect(repository.findByStatusNotIn([])).rejects.toThrow(
    /expects a non-empty array parameter/,
  );
  await expect(repository.findByStatus(undefined)).rejects.toThrow(
    /must not be undefined/,
  );
  expect(await repository.deleteAll()).toEqual(2);
  expect(await repository.count()).toEqual(0);
}

function createProductEntity(tableName) {
  class Product {}

  Id({ name: "product_id" })(Product.prototype, "id");
  Column({ name: "product_name" })(Product.prototype, "name");
  Column()(Product.prototype, "price");
  Column()(Product.prototype, "active");
  Column()(Product.prototype, "status");
  Column({ name: "created_at" })(Product.prototype, "createdAt");
  Version()(Product.prototype, "version");
  Entity({ name: tableName })(Product);

  return Product;
}

async function closeQueryable(adapter, queryable, table) {
  try {
    await adapter.executeSql(queryable, `DROP TABLE IF EXISTS ${table}`);
  } finally {
    await adapter.closeQueryable(queryable);
  }
}

async function startContainerOrSkip(container: {
  start(): Promise<StartedDatabaseContainer>;
}) {
  try {
    return await container.start();
  } catch (error) {
    if (isMissingContainerRuntimeError(error) && !isCi()) {
      return null;
    }

    throw error;
  }
}

async function createMysqlConnection(connectionUri) {
  let lastError;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    let driverConnection;

    try {
      driverConnection = await mysql.createConnection(connectionUri);
      const connection = new MysqlConnection(driverConnection);
      await connection.query("SELECT 1");
      return connection;
    } catch (error) {
      lastError = error;

      if (driverConnection) {
        await driverConnection.end().catch(() => {});
      }

      await delay(500);
    }
  }

  throw lastError;
}

async function createMysqlTransactionRuntime(connectionUri) {
  const pool = mysql.createPool(connectionUri);
  const manager = new MysqlTransactionManager(
    pool as unknown as MysqlTransactionConnection,
  );

  try {
    await waitForMysqlPool(manager);

    return {
      manager,
      queryable: manager.queryable,
      close: () => pool.end(),
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

async function waitForMysqlPool(manager) {
  let lastError;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await manager.queryable.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw lastError;
}

function isMissingContainerRuntimeError(error) {
  return (
    error instanceof Error &&
    /container runtime|docker/i.test(error.message)
  );
}

function isCi() {
  const value = process.env.CI;
  return Boolean(value && value !== "false" && value !== "0");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueTableName(adapterName) {
  const uniquePart = `${process.pid}_${Date.now().toString(36)}`;
  return `npa_e2e_${adapterName}_${uniquePart}`;
}

function quotePostgresqlIdentifier(identifier) {
  assertSafeIdentifier(identifier);
  return `"${identifier}"`;
}

function quoteMysqlIdentifier(identifier) {
  assertSafeIdentifier(identifier);
  return `\`${identifier}\``;
}

function assertSafeIdentifier(identifier) {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
}

export {
  assertRepositoryContract,
  createProductEntity,
  databaseAdapters,
  runDatabaseFlow,
  startContainerOrSkip,
  uniqueTableName,
};
