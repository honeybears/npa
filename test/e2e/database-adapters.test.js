const assert = require("node:assert/strict");
const test = require("node:test");

const { NPATransactionIsolation, Transaction } = require("../../dist");
const {
  assertRepositoryContract,
  createProductEntity,
  databaseAdapters,
  runDatabaseFlow,
} = require("./database-flow");

for (const adapter of databaseAdapters) {
  test(
    `runs ${adapter.name} repository E2E against a real database`,
    { timeout: 240_000 },
    (t) =>
      runDatabaseFlow(t, adapter, async ({ queryable, tableName }) => {
        const repository = adapter.createRepository({
          entity: createProductEntity(tableName),
          queryable,
        });

        await assertRepositoryContract(repository);
      }),
  );
}

for (const adapter of databaseAdapters) {
  test(
    `runs ${adapter.name} @Transaction E2E against a real database`,
    { timeout: 240_000 },
    (t) =>
      runDatabaseFlow(t, adapter, async ({ container, tableName }) => {
        const runtime = await adapter.createTransactionRuntime(container);

        try {
          const repository = adapter.createRepository({
            entity: createProductEntity(tableName),
            queryable: runtime.queryable,
          });
          const service = new ProductService(runtime.manager, repository);

          await assert.rejects(() => service.createThenFail(), /rollback/);
          assert.equal(await repository.count(), 0);

          await service.createTwo();
          assert.equal(await repository.count(), 2);

          const [created] = await repository.findAll();
          await service.renameManagedProduct(created.product_id, "dirty commit");
          const renamed = await repository.findById(created.product_id);
          assert.equal(renamed.product_name, "dirty commit");
          assert.equal(renamed.version, 1);
        } finally {
          await runtime.close();
        }
      }),
  );
}

class ProductService {
  constructor(transactionManager, repository) {
    this.transactionManager = transactionManager;
    this.repository = repository;
  }

  async createThenFail() {
    await this.repository.insert(product("rollback one", 10));
    await this.repository.insert(product("rollback two", 20));
    throw new Error("rollback");
  }

  async createTwo() {
    await this.repository.insert(product("commit one", 30));
    await this.repository.insert(product("commit two", 40));
  }

  async renameManagedProduct(id, name) {
    const productEntity = await this.repository.findById(id);

    if (!productEntity) {
      throw new Error("Product was not found.");
    }

    productEntity.name = name;
  }
}

decorateMethod(ProductService, "createThenFail", Transaction());
decorateMethod(
  ProductService,
  "createTwo",
  Transaction({ isolation: NPATransactionIsolation.READ_COMMITTED }),
);
decorateMethod(ProductService, "renameManagedProduct", Transaction());

function product(name, price) {
  return {
    name,
    price,
    active: true,
    status: "draft",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function decorateMethod(targetClass, methodName, decorator) {
  const descriptor = Object.getOwnPropertyDescriptor(
    targetClass.prototype,
    methodName,
  );
  decorator(targetClass.prototype, methodName, descriptor);
  Object.defineProperty(targetClass.prototype, methodName, descriptor);
}
