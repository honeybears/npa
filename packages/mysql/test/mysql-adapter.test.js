const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AbstractTransactionManager,
  Column,
  Entity,
  Id,
  Version,
  parseQueryMethod,
} = require("../../../dist");
const {
  compileMysqlCount,
  compileMysqlDeleteAll,
  compileMysqlDeleteById,
  compileMysqlExistsById,
  compileMysqlFindAll,
  compileMysqlInsert,
  compileMysqlQuery,
  compileMysqlUpdate,
  compileMysqlFindById,
  createMysqlDerivedQueryRepository,
  MysqlConnection,
} = require("../dist");
class Product {}

Id({ name: "product_id" })(Product.prototype, "id");
Column({ name: "product_name" })(Product.prototype, "name");
Column()(Product.prototype, "price");
Column()(Product.prototype, "active");
Column()(Product.prototype, "status");
Column({ name: "created_at" })(Product.prototype, "createdAt");
Entity({ name: "products", schema: "shop" })(Product);

class VersionedProduct {}

Id({ name: "product_id" })(VersionedProduct.prototype, "id");
Column({ name: "product_name" })(VersionedProduct.prototype, "name");
Column()(VersionedProduct.prototype, "price");
Version({ name: "lock_version" })(VersionedProduct.prototype, "version");
Entity({ name: "products", schema: "shop" })(VersionedProduct);

class TestTransactionManager extends AbstractTransactionManager {
  acquireTransactionResource() {
    return {};
  }

  beginTransaction() {}

  commitTransaction() {}

  rollbackTransaction() {}
}

test("compiles derived query methods into parameterized MySQL SQL", () => {
  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod(
          "findTop2ByNameContainingAndPriceGreaterThanOrderByCreatedAtDesc",
        ),
        args: ["desk", 100],
      },
      { entity: Product },
    ),
    {
      text:
        "SELECT * FROM `shop`.`products` WHERE (`product_name` LIKE ? AND `price` > ?) ORDER BY `created_at` DESC LIMIT 2",
      values: ["%desk%", 100],
    },
  );

  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("findByNameOrPriceGreaterThanAndActiveTrue"),
        args: ["desk", 100],
      },
      { entity: Product },
    ),
    {
      text:
        "SELECT * FROM `shop`.`products` WHERE (`product_name` = ?) OR (`price` > ? AND `active` IS TRUE)",
      values: ["desk", 100],
    },
  );
});

test("compiles insert, update, and deleteById MySQL CRUD SQL", () => {
  assert.deepEqual(
    compileMysqlInsert(
      { id: undefined, name: "desk", price: 120, createdAt: 10 },
      { entity: Product },
    ),
    {
      text:
        "INSERT INTO `shop`.`products` (`product_name`, `price`, `created_at`) VALUES (?, ?, ?)",
      values: ["desk", 120, 10],
    },
  );
  assert.deepEqual(
    compileMysqlUpdate(
      1,
      { id: 1, name: "chair", createdAt: 11 },
      { entity: Product },
    ),
    {
      text:
        "UPDATE `shop`.`products` SET `product_name` = ?, `created_at` = ? WHERE `product_id` = ?",
      values: ["chair", 11, 1],
    },
  );
  assert.deepEqual(compileMysqlDeleteById(1, { entity: Product }), {
    text: "DELETE FROM `shop`.`products` WHERE `product_id` = ?",
    values: [1],
  });
});

test("compiles JPA-style MySQL repository SQL", () => {
  assert.deepEqual(compileMysqlFindById(1, { entity: Product }), {
    text:
      "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
    values: [1],
  });
  assert.deepEqual(compileMysqlExistsById(1, { entity: Product }), {
    text:
      "SELECT EXISTS(SELECT 1 FROM `shop`.`products` WHERE `product_id` = ?) AS `exists`",
    values: [1],
  });
  assert.deepEqual(compileMysqlFindAll({ entity: Product }), {
    text: "SELECT * FROM `shop`.`products`",
    values: [],
  });
  assert.deepEqual(compileMysqlCount({ entity: Product }), {
    text: "SELECT COUNT(*) AS `count` FROM `shop`.`products`",
    values: [],
  });
  assert.deepEqual(compileMysqlDeleteAll({ entity: Product }), {
    text: "DELETE FROM `shop`.`products`",
    values: [],
  });
});

test("runs derived queries and CRUD through a mysql2-style queryable", async () => {
  const calls = [];
  const queryable = {
    async query(text, values) {
      calls.push({ text, values });

      if (text.startsWith("INSERT")) {
        return [{ affectedRows: 1, insertId: 10 }, []];
      }

      if (text.startsWith("UPDATE")) {
        return [{ affectedRows: 1 }, []];
      }

      if (text.startsWith("DELETE")) {
        return [{ affectedRows: 2 }, []];
      }

      if (text.startsWith("SELECT EXISTS")) {
        return [[{ exists: 1 }], []];
      }

      if (text.startsWith("SELECT COUNT")) {
        return [[{ count: "3" }], []];
      }

      if (text === "SELECT * FROM `shop`.`products`") {
        return [[{ product_id: 10, product_name: "desk" }], []];
      }

      return [[{ product_id: values[0], product_name: "desk" }], []];
    },
  };
  const repository = createMysqlDerivedQueryRepository(
    {},
    { entity: Product, queryable },
  );

  assert.deepEqual(await repository.insert({ name: "desk", price: 120 }), {
    product_id: 10,
    product_name: "desk",
  });
  assert.deepEqual(await repository.updateById(10, { name: "table" }), {
    product_id: 10,
    product_name: "desk",
  });
  assert.deepEqual(await repository.findById(10), {
    product_id: 10,
    product_name: "desk",
  });
  assert.equal(await repository.existsById(10), true);
  assert.deepEqual(await repository.findAll(), [
    { product_id: 10, product_name: "desk" },
  ]);
  assert.equal(await repository.count(), 3);
  assert.equal(await repository.existsByActiveTrue(), true);
  assert.equal(await repository.countByPriceGreaterThan(100), 3);
  assert.equal(await repository.deleteByStatusIn(["hidden", "sold"]), 2);
  assert.equal(await repository.deleteById(10), 2);
  assert.equal(await repository.deleteAll(), 2);

  assert.deepEqual(calls, [
    {
      text:
        "INSERT INTO `shop`.`products` (`product_name`, `price`) VALUES (?, ?)",
      values: ["desk", 120],
    },
    {
      text:
        "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
      values: [10],
    },
    {
      text:
        "UPDATE `shop`.`products` SET `product_name` = ? WHERE `product_id` = ?",
      values: ["table", 10],
    },
    {
      text:
        "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
      values: [10],
    },
    {
      text:
        "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
      values: [10],
    },
    {
      text:
        "SELECT EXISTS(SELECT 1 FROM `shop`.`products` WHERE `product_id` = ?) AS `exists`",
      values: [10],
    },
    {
      text: "SELECT * FROM `shop`.`products`",
      values: [],
    },
    {
      text: "SELECT COUNT(*) AS `count` FROM `shop`.`products`",
      values: [],
    },
    {
      text:
        "SELECT EXISTS(SELECT 1 FROM `shop`.`products` WHERE (`active` IS TRUE)) AS `exists`",
      values: [],
    },
    {
      text:
        "SELECT COUNT(*) AS `count` FROM `shop`.`products` WHERE (`price` > ?)",
      values: [100],
    },
    {
      text:
        "DELETE FROM `shop`.`products` WHERE (`status` IN (?, ?))",
      values: ["hidden", "sold"],
    },
    {
      text: "DELETE FROM `shop`.`products` WHERE `product_id` = ?",
      values: [10],
    },
    {
      text: "DELETE FROM `shop`.`products`",
      values: [],
    },
  ]);
});


test("flushes dirty managed entities through a MySQL repository", async () => {
  const calls = [];
  let lockVersion = 0;
  const queryable = {
    async query(text, values) {
      calls.push({ text, values });

      if (text.startsWith("UPDATE")) {
        lockVersion = 1;
        return [{ affectedRows: 1 }, []];
      }

      return [[{
        product_id: values[0],
        product_name: lockVersion === 0 ? "desk" : "chair",
        price: lockVersion === 0 ? 10 : 15,
        lock_version: lockVersion,
      }], []];
    },
  };
  const repository = createMysqlDerivedQueryRepository(
    {},
    { entity: VersionedProduct, queryable },
  );
  const manager = new TestTransactionManager();

  await manager.transactional(async () => {
    const productEntity = await repository.findById(10);
    productEntity.name = "chair";
    productEntity.price = 15;
  });

  assert.deepEqual(calls, [
    {
      text:
        "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
      values: [10],
    },
    {
      text:
        "UPDATE `shop`.`products` SET `product_name` = ?, `price` = ?, `lock_version` = `lock_version` + 1 WHERE `product_id` = ? AND `lock_version` = ?",
      values: ["chair", 15, 10, 0],
    },
    {
      text:
        "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
      values: [10],
    },
  ]);
});

test("wraps a mysql2-style pool or connection", async () => {
  const calls = [];
  let closed = false;
  const driverConnection = {
    async query(text, values) {
      calls.push({ method: "query", text, values });
      return [[{ id: 1 }], []];
    },
    async execute(text, values) {
      calls.push({ method: "execute", text, values });
      return [[{ id: 2 }], []];
    },
    async end() {
      closed = true;
    },
  };
  const connection = new MysqlConnection(driverConnection);

  assert.deepEqual(await connection.query("SELECT ?", [1]), [[{ id: 1 }], []]);
  assert.deepEqual(await connection.execute("SELECT ?", [2]), [
    [{ id: 2 }],
    [],
  ]);
  await connection.close();

  assert.equal(closed, true);
  assert.deepEqual(calls, [
    { method: "query", text: "SELECT ?", values: [1] },
    { method: "execute", text: "SELECT ?", values: [2] },
  ]);
});
