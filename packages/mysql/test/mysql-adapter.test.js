const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AbstractTransactionManager,
  Column,
  Entity,
  Id,
  ManyToMany,
  ManyToOne,
  NPARepository,
  OneToMany,
  Query,
  Repository,
  Version,
  createNPA,
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
  compileMysqlRawQuery,
  compileMysqlUpdate,
  compileMysqlFindById,
  createMysqlDerivedQueryRepository,
  MysqlConnection,
  mysql,
} = require("../dist");
class Product {}

Id({ name: "product_id" })(Product.prototype, "id");
Column({ name: "product_name" })(Product.prototype, "name");
Column()(Product.prototype, "price");
Column()(Product.prototype, "active");
Column()(Product.prototype, "status");
Column({ name: "created_at" })(Product.prototype, "createdAt");
Entity({ name: "products", schema: "shop" })(Product);

class ProductRepository extends NPARepository {
  repositoryName() {
    return "mysql-products";
  }
}

Repository(Product)(ProductRepository);

class Team {}
Id({ name: "team_id" })(Team.prototype, "id");
Column()(Team.prototype, "label");
OneToMany(() => Member, { mappedBy: "team" })(Team.prototype, "members");
Entity({ name: "teams" })(Team);

class Role {}
Id({ name: "role_id" })(Role.prototype, "id");
Column()(Role.prototype, "name");
Entity({ name: "roles" })(Role);

class Member {}
Id({ name: "member_id" })(Member.prototype, "id");
Column()(Member.prototype, "name");
ManyToOne(() => Team, { joinColumn: "team_id" })(Member.prototype, "team");
ManyToMany(() => Role, { joinTable: "member_roles" })(Member.prototype, "roles");
Entity({ name: "members" })(Member);

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
        query: parseQueryMethod(
          "findDistinctTop2ByNameContainingIgnoreCaseAndStatusAllIgnoreCaseOrderByNameAscPriceDesc",
        ),
        args: ["DESK", "ACTIVE"],
      },
      { entity: Product },
    ),
    {
      text:
        "SELECT DISTINCT * FROM `shop`.`products` WHERE (LOWER(`product_name`) LIKE ? AND LOWER(`status`) = ?) ORDER BY `product_name` ASC, `price` DESC LIMIT 2",
      values: ["%desk%", "active"],
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

test("compiles MySQL null and empty-list derived query parameters", () => {
  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("findByName"),
        args: [null],
      },
      { entity: Product },
    ),
    {
      text: "SELECT * FROM `shop`.`products` WHERE (`product_name` IS NULL)",
      values: [],
    },
  );

  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("findByNameNot"),
        args: [null],
      },
      { entity: Product },
    ),
    {
      text: "SELECT * FROM `shop`.`products` WHERE (`product_name` IS NOT NULL)",
      values: [],
    },
  );

  assert.throws(
    () =>
      compileMysqlQuery(
        {
          query: parseQueryMethod("findByStatusIn"),
          args: [[]],
        },
        { entity: Product },
      ),
    /expects a non-empty array parameter/,
  );

  assert.throws(
    () =>
      compileMysqlQuery(
        {
          query: parseQueryMethod("findByStatusNotIn"),
          args: [[]],
        },
        { entity: Product },
      ),
    /expects a non-empty array parameter/,
  );

  assert.throws(
    () =>
      compileMysqlQuery(
        {
          query: parseQueryMethod("findByName"),
          args: [undefined],
        },
        { entity: Product },
      ),
    /must not be undefined/,
  );
});

test("compiles MySQL derived queries across relation fields", () => {
  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("findByTeam"),
        args: [{ id: 7, label: "platform" }],
      },
      { entity: Member },
    ),
    {
      text:
        "SELECT * FROM `members` WHERE (`team_id` = ?)",
      values: [7],
    },
  );

  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("findByTeamIn"),
        args: [[{ id: 7, label: "platform" }, { id: 8, label: "infra" }]],
      },
      { entity: Member },
    ),
    {
      text:
        "SELECT * FROM `members` WHERE (`team_id` IN (?, ?))",
      values: [7, 8],
    },
  );

  assert.throws(
    () =>
      compileMysqlQuery(
        {
          query: parseQueryMethod("findByTeam"),
          args: [{ label: "platform" }],
        },
        { entity: Member },
      ),
    /Relation team requires Team.id or team_id/,
  );

  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("findByTeamLabelAndNameOrderByTeamLabelDesc"),
        args: ["platform", "kim"],
      },
      { entity: Member },
    ),
    {
      text:
        "SELECT `npa_0`.* FROM `members` AS `npa_0` JOIN `teams` AS `npa_1` ON `npa_0`.`team_id` = `npa_1`.`team_id` WHERE (`npa_1`.`label` = ? AND `npa_0`.`name` = ?) ORDER BY `npa_1`.`label` DESC",
      values: ["platform", "kim"],
    },
  );

  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("countByMembersName"),
        args: ["kim"],
      },
      { entity: Team },
    ),
    {
      text:
        "SELECT COUNT(*) AS `count` FROM `teams` AS `npa_0` JOIN `members` AS `npa_1` ON `npa_1`.`team_id` = `npa_0`.`team_id` WHERE (`npa_1`.`name` = ?)",
      values: ["kim"],
    },
  );

  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("countDistinctByTeamLabelIgnoreCase"),
        args: ["PLATFORM"],
      },
      { entity: Member },
    ),
    {
      text:
        "SELECT COUNT(DISTINCT `npa_0`.`member_id`) AS `count` FROM `members` AS `npa_0` JOIN `teams` AS `npa_1` ON `npa_0`.`team_id` = `npa_1`.`team_id` WHERE (LOWER(`npa_1`.`label`) = ?)",
      values: ["platform"],
    },
  );

  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("findByRolesName"),
        args: ["admin"],
      },
      { entity: Member },
    ),
    {
      text:
        "SELECT `npa_0`.* FROM `members` AS `npa_0` JOIN `member_roles` AS `npa_2` ON `npa_2`.`member_id` = `npa_0`.`member_id` JOIN `roles` AS `npa_1` ON `npa_1`.`role_id` = `npa_2`.`role_id` WHERE (`npa_1`.`name` = ?)",
      values: ["admin"],
    },
  );

  assert.deepEqual(
    compileMysqlQuery(
      {
        query: parseQueryMethod("deleteByTeamLabel"),
        args: ["platform"],
      },
      { entity: Member },
    ),
    {
      text:
        "DELETE `npa_0` FROM `members` AS `npa_0` JOIN `teams` AS `npa_1` ON `npa_0`.`team_id` = `npa_1`.`team_id` WHERE (`npa_1`.`label` = ?)",
      values: ["platform"],
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

test("creates MySQL repositories from @Repository tokens", async () => {
  const calls = [];
  const queryable = {
    async query(text, values) {
      calls.push({ text, values });

      return [[{ product_id: values[0], product_name: "desk" }], []];
    },
  };
  const npa = createNPA({
    adapter: mysql({ queryable }),
    repositories: [ProductRepository],
  });
  const products = npa.get(ProductRepository);

  assert.equal(products instanceof ProductRepository, true);
  assert.equal(products.repositoryName(), "mysql-products");
  assert.deepEqual(await products.findById(10), {
    product_id: 10,
    product_name: "desk",
  });
  assert.deepEqual(await products.findByName("desk"), [
    { product_id: "desk", product_name: "desk" },
  ]);

  assert.deepEqual(calls, [
    {
      text:
        "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
      values: [10],
    },
    {
      text: "SELECT * FROM `shop`.`products` WHERE (`product_name` = ?)",
      values: ["desk"],
    },
  ]);
});

test("executes @Query raw MySQL repository methods", async () => {
  const calls = [];
  const queryable = {
    query(text, values = []) {
      calls.push({ text, values });

      if (text.startsWith("SELECT COUNT")) {
        return [[{ total: "2" }], []];
      }

      if (text.startsWith("UPDATE")) {
        return [{ affectedRows: 3 }, []];
      }

      return [[{ product_id: values[0] ?? 1, product_name: "desk" }], []];
    },
  };

  class RawProductRepository extends NPARepository {}

  Query("SELECT * FROM `products` WHERE `price` > :minPrice", { result: "many" })(
    RawProductRepository.prototype,
    "findExpensiveProducts",
  );
  Query("SELECT * FROM `products` WHERE `product_id` = :id", { result: "one" })(
    RawProductRepository.prototype,
    "findOneProductRaw",
  );
  Query("SELECT COUNT(*) AS total FROM `products` WHERE `price` > :minPrice", { result: "scalar" })(
    RawProductRepository.prototype,
    "countProductsRaw",
  );
  Query("UPDATE `products` SET `price` = `price` + :amount WHERE `price` < :amount", { result: "execute" })(
    RawProductRepository.prototype,
    "raisePricesRaw",
  );

  const repository = createMysqlDerivedQueryRepository(
    Object.create(RawProductRepository.prototype),
    { entity: Product, queryable },
  );

  assert.deepEqual(await repository.findExpensiveProducts(100), [
    { product_id: 100, product_name: "desk" },
  ]);
  assert.deepEqual(await repository.findOneProductRaw(7), {
    product_id: 7,
    product_name: "desk",
  });
  assert.equal(await repository.countProductsRaw(10), "2");
  assert.equal(await repository.raisePricesRaw(5), 3);

  assert.deepEqual(calls, [
    {
      text: "SELECT * FROM `products` WHERE `price` > ?",
      values: [100],
    },
    {
      text: "SELECT * FROM `products` WHERE `product_id` = ?",
      values: [7],
    },
    {
      text: "SELECT COUNT(*) AS total FROM `products` WHERE `price` > ?",
      values: [10],
    },
    {
      text: "UPDATE `products` SET `price` = `price` + ? WHERE `price` < ?",
      values: [5, 5],
    },
  ]);
});

test("handles empty and null @Query raw MySQL results", async () => {
  const queryable = {
    query(text) {
      if (text.includes("COUNT_EMPTY")) {
        return [[], []];
      }

      if (text.includes("COUNT_NULL")) {
        return [[{ total: null }], []];
      }

      if (text.startsWith("UPDATE")) {
        return [{ affectedRows: 0 }, []];
      }

      return [[], []];
    },
  };

  class RawProductRepository extends NPARepository {}

  Query("SELECT * FROM `products`", { result: "many" })(
    RawProductRepository.prototype,
    "findProductsRaw",
  );
  Query("SELECT * FROM `products` WHERE `product_id` = :id", { result: "one" })(
    RawProductRepository.prototype,
    "findOneProductRaw",
  );
  Query("SELECT COUNT_EMPTY AS total", { result: "scalar" })(
    RawProductRepository.prototype,
    "countEmptyRaw",
  );
  Query("SELECT COUNT_NULL AS total", { result: "scalar" })(
    RawProductRepository.prototype,
    "countNullRaw",
  );
  Query("UPDATE `products` SET `price` = `price`", { result: "execute" })(
    RawProductRepository.prototype,
    "touchProductsRaw",
  );

  const repository = createMysqlDerivedQueryRepository(
    Object.create(RawProductRepository.prototype),
    { entity: Product, queryable },
  );

  assert.deepEqual(await repository.findProductsRaw(), []);
  assert.equal(await repository.findOneProductRaw(1), null);
  assert.equal(await repository.countEmptyRaw(), null);
  assert.equal(await repository.countNullRaw(), null);
  assert.equal(await repository.touchProductsRaw(), 0);
});

test("binds raw MySQL named and positional parameters safely", () => {
  assert.deepEqual(
    compileMysqlRawQuery(
      "SELECT ':id' AS literal WHERE `owner_id` = :id OR `reviewer_id` = :id AND `status` = :status",
      [7, "active"],
      "findRaw",
    ),
    {
      text:
        "SELECT ':id' AS literal WHERE `owner_id` = ? OR `reviewer_id` = ? AND `status` = ?",
      values: [7, 7, "active"],
    },
  );

  assert.deepEqual(
    compileMysqlRawQuery(
      "SELECT '?' AS literal WHERE `id` = ?",
      [1],
      "findRaw",
    ),
    {
      text: "SELECT '?' AS literal WHERE `id` = ?",
      values: [1],
    },
  );

  assert.throws(
    () =>
      compileMysqlRawQuery(
        "SELECT :id, :status",
        [7],
        "findRaw",
      ),
    /uses named parameter/,
  );
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

test("loads MySQL many-to-one, one-to-many, and many-to-many relations", async () => {
  const calls = [];
  const queryable = {
    async query(text, values) {
      calls.push({ text, values });

      if (text === "SELECT * FROM `members` WHERE `member_id` = ? LIMIT 1") {
        return [[{ member_id: values[0], name: "kim", team_id: 2 }], []];
      }

      if (text === "SELECT * FROM `teams` WHERE `team_id` IN (?)") {
        return [[{ team_id: 2, label: "core" }], []];
      }

      if (text.includes("FROM `member_roles` j")) {
        return [[
          { __npa_source_id: 10, role_id: 7, name: "admin" },
          { __npa_source_id: 10, role_id: 8, name: "writer" },
        ], []];
      }

      if (text === "SELECT * FROM `teams`") {
        return [[{ team_id: 2, label: "core" }], []];
      }

      if (text === "SELECT * FROM `members` WHERE `team_id` IN (?)") {
        return [[
          { member_id: 10, name: "kim", team_id: 2 },
          { member_id: 11, name: "lee", team_id: 2 },
        ], []];
      }

      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const members = createMysqlDerivedQueryRepository(
    {},
    { entity: Member, queryable },
  );
  const teams = createMysqlDerivedQueryRepository(
    {},
    { entity: Team, queryable },
  );

  const member = await members.findById(10, { relations: ["team", "roles"] });
  assert.deepEqual(member.team, { team_id: 2, label: "core" });
  assert.deepEqual(member.roles, [
    { role_id: 7, name: "admin" },
    { role_id: 8, name: "writer" },
  ]);

  const [team] = await teams.findAll({ relations: ["members"] });
  assert.deepEqual(team.members, [
    { member_id: 10, name: "kim", team_id: 2 },
    { member_id: 11, name: "lee", team_id: 2 },
  ]);

  assert.equal(calls.length, 5);
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
