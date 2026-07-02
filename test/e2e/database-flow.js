const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");
const { Pool } = require("pg");
const { MySqlContainer } = require("@testcontainers/mysql");
const { PostgreSqlContainer } = require("@testcontainers/postgresql");

const {
  Column,
  Entity,
  Id,
  Version,
} = require("../../dist");
const {
  PostgresqlConnection,
  PostgresqlTransactionManager,
  createPostgresqlDerivedQueryRepository,
} = require("../../packages/pg/dist");
const {
  MysqlConnection,
  MysqlTransactionManager,
  createMysqlDerivedQueryRepository,
} = require("../../packages/mysql/dist");

const POSTGRESQL_IMAGE =
  process.env.NPA_E2E_POSTGRESQL_IMAGE ?? "postgres:16-alpine";
const MYSQL_IMAGE = process.env.NPA_E2E_MYSQL_IMAGE ?? "mysql:8.0";

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

async function runDatabaseFlow(t, adapter, flow) {
  const tableName = uniqueTableName(adapter.tablePrefix);
  const table = adapter.quoteIdentifier(tableName);
  const container = await startContainerOrSkip(t, adapter.createContainer());

  if (!container) {
    return;
  }

  let queryable;

  t.after(async () => {
    try {
      if (queryable) {
        await closeQueryable(adapter, queryable, table);
      }
    } finally {
      await container.stop();
    }
  });

  queryable = await adapter.createQueryable(container);
  await adapter.executeSql(queryable, adapter.createTableSql(table));

  await flow({
    adapter,
    container,
    queryable,
    tableName,
  });
}

async function assertRepositoryContract(repository, options = {}) {
  const first = await repository.insert({
    name: "desk alpha",
    price: 120,
    active: true,
    status: "draft",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const firstId = first.product_id;

  assert.equal(typeof firstId, "number");
  assert.equal(first.product_name, "desk alpha");
  assert.equal(first.price, 120);
  assert.equal(first.version, 0);
  assert.equal(await repository.existsById(firstId), true);
  assert.equal(await repository.existsById(firstId + 1000), false);
  assert.deepEqual(await repository.findById(firstId), first);
  assert.equal(await repository.findById(firstId + 1000), null);
  assert.equal(await repository.findOneByName("missing product"), null);
  assert.equal(await repository.deleteByStatus("missing"), 0);

  const updated = await repository.updateById(firstId, {
    name: "desk beta",
    price: 150,
    active: true,
    status: "published",
  });

  assert.equal(updated.product_id, firstId);
  assert.equal(updated.product_name, "desk beta");
  assert.equal(updated.price, 150);
  assert.equal(updated.status, "published");

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

  assert.equal(await repository.count(), 3);
  assert.deepEqual(
    (await repository.findAll()).map((row) => row.product_name).sort(),
    ["chair beta", "desk beta", "desk gamma"],
  );

  const desks =
    await repository.findTop2ByNameContainingAndPriceGreaterThanOrderByCreatedAtDesc(
      "desk",
      100,
    );
  assert.deepEqual(
    desks.map((row) => row.product_name),
    ["desk gamma", "desk beta"],
  );

  assert.equal(await repository.existsByActiveTrueAndStatus("published"), true);
  assert.equal(await repository.existsByActiveFalse(), true);
  assert.equal(await repository.countByPriceBetween(100, 300), 2);
  assert.equal(await repository.deleteByStatusIn(["archived", "draft"]), 2);
  assert.equal(await repository.countByPriceGreaterThan(0), 1);
  assert.equal(await repository.deleteById(firstId), 1);
  assert.equal(await repository.countByPriceGreaterThan(0), 0);
  await repository.insert({
    name: "floor lamp",
    price: 40,
    active: true,
    status: "draft",
    createdAt: new Date("2026-01-04T00:00:00.000Z"),
  });
  assert.equal(await repository.deleteAll(), 1);
  assert.equal(await repository.count(), 0);

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

  assert.deepEqual(
    (await repository.findByStatus(null)).map((row) => row.product_name),
    ["null status"],
  );
  assert.deepEqual(
    (await repository.findByStatusIsNull()).map((row) => row.product_name),
    ["null status"],
  );
  await assert.rejects(
    () => repository.findByStatusIn([]),
    /expects a non-empty array parameter/,
  );
  await assert.rejects(
    () => repository.findByStatusNotIn([]),
    /expects a non-empty array parameter/,
  );
  await assert.rejects(
    () => repository.findByStatus(undefined),
    /must not be undefined/,
  );
  assert.equal(await repository.deleteAll(), 2);
  assert.equal(await repository.count(), 0);
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

async function startContainerOrSkip(t, container) {
  try {
    return await container.start();
  } catch (error) {
    if (isMissingContainerRuntimeError(error) && !isCi()) {
      t.skip(
        "Skipping Testcontainers E2E because no container runtime is available.",
      );
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
  const manager = new MysqlTransactionManager(pool);

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

module.exports = {
  assertRepositoryContract,
  createProductEntity,
  databaseAdapters,
  runDatabaseFlow,
  startContainerOrSkip,
  uniqueTableName,
};
