import { AbstractTransactionManager, Column, Entity, Id, ManyToMany, ManyToOne, NPARepository, OneToMany, Query, Repository, Version, createNPA, parseQueryMethod } from "../../../src";
import { compileMysqlCount, compileMysqlDeleteAll, compileMysqlDeleteById, compileMysqlExistsById, compileMysqlFindAll, compileMysqlInsert, compileMysqlQuery, compileMysqlRawQuery, compileMysqlUpdate, compileMysqlVersionedUpdate, compileMysqlFindById, createMysqlDerivedQueryRepository, MysqlConnection, mysql, type MysqlDriverConnection, type MysqlQueryable } from "../src";
import { describe, expect, test } from "@jest/globals";

type DynamicRepository = Record<string, (...args: unknown[]) => unknown>;

function asMysqlQueryable(queryable: unknown): MysqlQueryable {
  return queryable as MysqlQueryable;
}

class Product {
  id!: number;
  name!: string;
  price!: number;
  active!: boolean;
  status!: string;
  createdAt!: number;
}

Id({ name: "product_id" })(Product.prototype, "id");
Column({ name: "product_name" })(Product.prototype, "name");
Column()(Product.prototype, "price");
Column()(Product.prototype, "active");
Column()(Product.prototype, "status");
Column({ name: "created_at" })(Product.prototype, "createdAt");
Entity({ name: "products", schema: "shop" })(Product);

abstract class ProductRepository extends NPARepository<Product, number> {
  repositoryName(): string {
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

class BrokenTeam {}
Id({ name: "team_id" })(BrokenTeam.prototype, "id");
Column()(BrokenTeam.prototype, "label");
OneToMany(() => BrokenMember)(BrokenTeam.prototype, "members");
Entity({ name: "broken_teams" })(BrokenTeam);

class BrokenMember {}
Id({ name: "member_id" })(BrokenMember.prototype, "id");
Column()(BrokenMember.prototype, "name");
Entity({ name: "broken_members" })(BrokenMember);

class VersionedProduct {
  id!: number;
  name!: string;
  price!: number;
  version!: number;
}

Id({ name: "product_id" })(VersionedProduct.prototype, "id");
Column({ name: "product_name" })(VersionedProduct.prototype, "name");
Column()(VersionedProduct.prototype, "price");
Version({ name: "lock_version" })(VersionedProduct.prototype, "version");
Entity({ name: "products", schema: "shop" })(VersionedProduct);

class TestTransactionManager extends AbstractTransactionManager<object> {
  protected acquireTransactionResource() {
    return {};
  }

  protected beginTransaction() {}

  protected commitTransaction() {}

  protected rollbackTransaction() {}
}
describe("MySQL adapter", () => {
  test("compiles derived query methods into parameterized MySQL SQL", () => {
    expect(compileMysqlQuery(
        {
          query: parseQueryMethod(
            "findTop2ByNameContainingAndPriceGreaterThanOrderByCreatedAtDesc",
          ),
          args: ["desk", 100],
        },
        { entity: Product },
      )).toEqual({
        text:
          "SELECT * FROM `shop`.`products` WHERE (`product_name` LIKE ? AND `price` > ?) ORDER BY `created_at` DESC LIMIT 2",
        values: ["%desk%", 100],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod(
            "findDistinctTop2ByNameContainingIgnoreCaseAndStatusAllIgnoreCaseOrderByNameAscPriceDesc",
          ),
          args: ["DESK", "ACTIVE"],
        },
        { entity: Product },
      )).toEqual({
        text:
          "SELECT DISTINCT * FROM `shop`.`products` WHERE (LOWER(`product_name`) LIKE ? AND LOWER(`status`) = ?) ORDER BY `product_name` ASC, `price` DESC LIMIT 2",
        values: ["%desk%", "active"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByNameOrPriceGreaterThanAndActiveTrue"),
          args: ["desk", 100],
        },
        { entity: Product },
      )).toEqual({
        text:
          "SELECT * FROM `shop`.`products` WHERE (`product_name` = ?) OR (`price` > ? AND `active` IS TRUE)",
        values: ["desk", 100],
      });
  });

  test("compiles MySQL null and empty-list derived query parameters", () => {
    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByName"),
          args: [null],
        },
        { entity: Product },
      )).toEqual({
        text: "SELECT * FROM `shop`.`products` WHERE (`product_name` IS NULL)",
        values: [],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByNameNot"),
          args: [null],
        },
        { entity: Product },
      )).toEqual({
        text: "SELECT * FROM `shop`.`products` WHERE (`product_name` IS NOT NULL)",
        values: [],
      });

    expect(() =>
        compileMysqlQuery(
          {
            query: parseQueryMethod("findByStatusIn"),
            args: [[]],
          },
          { entity: Product },
        )).toThrow(/expects a non-empty array parameter/);

    expect(() =>
        compileMysqlQuery(
          {
            query: parseQueryMethod("findByStatusNotIn"),
            args: [[]],
          },
          { entity: Product },
        )).toThrow(/expects a non-empty array parameter/);

    expect(() =>
        compileMysqlQuery(
          {
            query: parseQueryMethod("findByName"),
            args: [undefined],
          },
          { entity: Product },
        )).toThrow(/must not be undefined/);
  });

  test("compiles MySQL derived queries across relation fields", () => {
    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByTeam"),
          args: [{ id: 7, label: "platform" }],
        },
        { entity: Member },
      )).toEqual({
        text:
          "SELECT * FROM `members` WHERE (`team_id` = ?)",
        values: [7],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByTeamIn"),
          args: [[{ id: 7, label: "platform" }, { id: 8, label: "infra" }]],
        },
        { entity: Member },
      )).toEqual({
        text:
          "SELECT * FROM `members` WHERE (`team_id` IN (?, ?))",
        values: [7, 8],
      });

    expect(() =>
        compileMysqlQuery(
          {
            query: parseQueryMethod("findByTeam"),
            args: [{ label: "platform" }],
          },
          { entity: Member },
        )).toThrow(/Relation team requires Team.id or team_id/);

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByTeamLabelAndNameOrderByTeamLabelDesc"),
          args: ["platform", "kim"],
        },
        { entity: Member },
      )).toEqual({
        text:
          "SELECT `npa_0`.* FROM `members` AS `npa_0` JOIN `teams` AS `npa_1` ON `npa_0`.`team_id` = `npa_1`.`team_id` WHERE (`npa_1`.`label` = ? AND `npa_0`.`name` = ?) ORDER BY `npa_1`.`label` DESC",
        values: ["platform", "kim"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("countByMembersName"),
          args: ["kim"],
        },
        { entity: Team },
      )).toEqual({
        text:
          "SELECT COUNT(*) AS `count` FROM `teams` AS `npa_0` JOIN `members` AS `npa_1` ON `npa_1`.`team_id` = `npa_0`.`team_id` WHERE (`npa_1`.`name` = ?)",
        values: ["kim"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("countDistinctByTeamLabelIgnoreCase"),
          args: ["PLATFORM"],
        },
        { entity: Member },
      )).toEqual({
        text:
          "SELECT COUNT(DISTINCT `npa_0`.`member_id`) AS `count` FROM `members` AS `npa_0` JOIN `teams` AS `npa_1` ON `npa_0`.`team_id` = `npa_1`.`team_id` WHERE (LOWER(`npa_1`.`label`) = ?)",
        values: ["platform"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByRolesName"),
          args: ["admin"],
        },
        { entity: Member },
      )).toEqual({
        text:
          "SELECT `npa_0`.* FROM `members` AS `npa_0` JOIN `member_roles` AS `npa_2` ON `npa_2`.`member_id` = `npa_0`.`member_id` JOIN `roles` AS `npa_1` ON `npa_1`.`role_id` = `npa_2`.`role_id` WHERE (`npa_1`.`name` = ?)",
        values: ["admin"],
      });

    expect(() =>
        compileMysqlQuery(
          {
            query: parseQueryMethod("findByRolesMissing"),
            args: ["admin"],
          },
          { entity: Member },
        )).toThrow(/Relation query Member\.rolesMissing targets Role\.missing, but that property is not a column/);

    expect(() =>
        compileMysqlQuery(
          {
            query: parseQueryMethod("findByMembersName"),
            args: ["kim"],
          },
          { entity: BrokenTeam },
        )).toThrow(/@OneToMany BrokenTeam\.members requires mappedBy/);

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("deleteByTeamLabel"),
          args: ["platform"],
        },
        { entity: Member },
      )).toEqual({
        text:
          "DELETE `npa_0` FROM `members` AS `npa_0` JOIN `teams` AS `npa_1` ON `npa_0`.`team_id` = `npa_1`.`team_id` WHERE (`npa_1`.`label` = ?)",
        values: ["platform"],
      });
  });

  test("compiles insert, update, and deleteById MySQL CRUD SQL", () => {
    expect(compileMysqlInsert(
        { id: undefined, name: "desk", price: 120, createdAt: 10 },
        { entity: Product },
      )).toEqual({
        text:
          "INSERT INTO `shop`.`products` (`product_name`, `price`, `created_at`) VALUES (?, ?, ?)",
        values: ["desk", 120, 10],
      });
    expect(compileMysqlUpdate(
        1,
        { id: 1, name: "chair", createdAt: 11 },
        { entity: Product },
      )).toEqual({
        text:
          "UPDATE `shop`.`products` SET `product_name` = ?, `created_at` = ? WHERE `product_id` = ?",
        values: ["chair", 11, 1],
      });
    expect(() => compileMysqlUpdate(1, { id: 1 }, { entity: Product })).toThrow(/without changed values/);
    expect(() =>
        compileMysqlVersionedUpdate(
          1,
          { id: 1, version: 2 },
          2,
          { entity: VersionedProduct },
        )).toThrow(/without changed values/);
    expect(compileMysqlUpdate(
        1,
        { displayName: "desk" },
        {
          schema: "shop`schema",
          tableName: "products`archive",
          columns: {
            displayName: "display`name",
          },
        },
      )).toEqual({
        text:
          "UPDATE `shop``schema`.`products``archive` SET `display``name` = ? WHERE `id` = ?",
        values: ["desk", 1],
      });
    expect(compileMysqlDeleteById(1, { entity: Product })).toEqual({
      text: "DELETE FROM `shop`.`products` WHERE `product_id` = ?",
      values: [1],
    });
  });

  test("compiles JPA-style MySQL repository SQL", () => {
    expect(compileMysqlFindById(1, { entity: Product })).toEqual({
      text:
        "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
      values: [1],
    });
    expect(compileMysqlExistsById(1, { entity: Product })).toEqual({
      text:
        "SELECT EXISTS(SELECT 1 FROM `shop`.`products` WHERE `product_id` = ?) AS `exists`",
      values: [1],
    });
    expect(compileMysqlFindAll({ entity: Product })).toEqual({
      text: "SELECT * FROM `shop`.`products`",
      values: [],
    });
    expect(compileMysqlCount({ entity: Product })).toEqual({
      text: "SELECT COUNT(*) AS `count` FROM `shop`.`products`",
      values: [],
    });
    expect(compileMysqlDeleteAll({ entity: Product })).toEqual({
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
      adapter: mysql({ queryable: asMysqlQueryable(queryable) }),
      repositories: [ProductRepository],
    });
    const products = npa.get(ProductRepository) as ProductRepository & DynamicRepository;

    expect(products instanceof ProductRepository).toEqual(true);
    expect(products.repositoryName()).toEqual("mysql-products");
    expect(await products.findById(10)).toEqual({
      product_id: 10,
      product_name: "desk",
    });
    expect(await products.findByName("desk")).toEqual([
      { product_id: "desk", product_name: "desk" },
    ]);

    expect(calls).toEqual([
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

    abstract class RawProductRepository extends NPARepository<Product, number> {}

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
      { entity: Product, queryable: asMysqlQueryable(queryable) },
    ) as DynamicRepository;

    expect(await repository.findExpensiveProducts(100)).toEqual([
      { product_id: 100, product_name: "desk" },
    ]);
    expect(await repository.findOneProductRaw(7)).toEqual({
      product_id: 7,
      product_name: "desk",
    });
    expect(await repository.countProductsRaw(10)).toEqual("2");
    expect(await repository.raisePricesRaw(5)).toEqual(3);

    expect(calls).toEqual([
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

    abstract class RawProductRepository extends NPARepository<Product, number> {}

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
      { entity: Product, queryable: asMysqlQueryable(queryable) },
    ) as DynamicRepository;

    expect(await repository.findProductsRaw()).toEqual([]);
    expect(await repository.findOneProductRaw(1)).toEqual(null);
    expect(await repository.countEmptyRaw()).toEqual(null);
    expect(await repository.countNullRaw()).toEqual(null);
    expect(await repository.touchProductsRaw()).toEqual(0);
  });

  test("binds raw MySQL named and positional parameters safely", () => {
    expect(compileMysqlRawQuery(
        "SELECT ':id' AS literal WHERE `owner_id` = :id OR `reviewer_id` = :id AND `status` = :status",
        [7, "active"],
        "findRaw",
      )).toEqual({
        text:
          "SELECT ':id' AS literal WHERE `owner_id` = ? OR `reviewer_id` = ? AND `status` = ?",
        values: [7, 7, "active"],
      });

    expect(compileMysqlRawQuery(
        "SELECT '?' AS literal WHERE `id` = ?",
        [1],
        "findRaw",
      )).toEqual({
        text: "SELECT '?' AS literal WHERE `id` = ?",
        values: [1],
      });

    expect(() =>
        compileMysqlRawQuery(
          "SELECT :id, :status",
          [7],
          "findRaw",
        )).toThrow(/uses named parameter/);
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
      { entity: Product, queryable: asMysqlQueryable(queryable) },
    ) as NPARepository<Record<string, unknown>, unknown> & DynamicRepository;

    expect(await repository.insert({ name: "desk", price: 120 })).toEqual({
      product_id: 10,
      product_name: "desk",
    });
    expect(await repository.updateById(10, { name: "table" })).toEqual({
      product_id: 10,
      product_name: "desk",
    });
    expect(await repository.findById(10)).toEqual({
      product_id: 10,
      product_name: "desk",
    });
    expect(await repository.existsById(10)).toEqual(true);
    expect(await repository.findAll()).toEqual([
      { product_id: 10, product_name: "desk" },
    ]);
    expect(await repository.count()).toEqual(3);
    expect(await repository.existsByActiveTrue()).toEqual(true);
    expect(await repository.countByPriceGreaterThan(100)).toEqual(3);
    expect(await repository.deleteByStatusIn(["hidden", "sold"])).toEqual(2);
    expect(await repository.deleteById(10)).toEqual(2);
    expect(await repository.deleteAll()).toEqual(2);

    expect(calls).toEqual([
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

  test("uses optimistic MySQL updateById SQL only for versioned entities", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("UPDATE")) {
          return [{ affectedRows: 1 }, []];
        }

        return [[{
          product_id: values[0],
          product_name: "chair",
          lock_version: 1,
        }], []];
      },
    };
    const versioned = createMysqlDerivedQueryRepository(
      {},
      { entity: VersionedProduct, queryable: asMysqlQueryable(queryable) },
    );
    const plain = createMysqlDerivedQueryRepository(
      {},
      { entity: Product, queryable: asMysqlQueryable(queryable) },
    );

    await versioned.updateById(10, { name: "chair", version: 0 });
    await plain.updateById(11, { name: "desk" });

    expect(calls).toEqual([
      {
        text:
          "UPDATE `shop`.`products` SET `product_name` = ?, `lock_version` = `lock_version` + 1 WHERE `product_id` = ? AND `lock_version` = ?",
        values: ["chair", 10, 0],
      },
      {
        text:
          "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
        values: [10],
      },
      {
        text:
          "UPDATE `shop`.`products` SET `product_name` = ? WHERE `product_id` = ?",
        values: ["desk", 11],
      },
      {
        text:
          "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
        values: [11],
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
      { entity: Member, queryable: asMysqlQueryable(queryable) },
    );
    const teams = createMysqlDerivedQueryRepository(
      {},
      { entity: Team, queryable: asMysqlQueryable(queryable) },
    );

    const member = await members.findById(10, { relations: ["team", "roles"] });
    expect(member.team).toEqual({ team_id: 2, label: "core" });
    expect(member.roles).toEqual([
      { role_id: 7, name: "admin" },
      { role_id: 8, name: "writer" },
    ]);

    const [team] = await teams.findAll({ relations: ["members"] });
    expect(team.members).toEqual([
      { member_id: 10, name: "kim", team_id: 2 },
      { member_id: 11, name: "lee", team_id: 2 },
    ]);

    expect(calls.length).toEqual(5);
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
      { entity: VersionedProduct, queryable: asMysqlQueryable(queryable) },
    );
    const manager = new TestTransactionManager();

    await manager.transactional(async () => {
      const productEntity = await repository.findById(10);
      productEntity.name = "chair";
      productEntity.price = 15;
    });

    expect(calls).toEqual([
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
    const connection = new MysqlConnection(
      driverConnection as unknown as MysqlDriverConnection,
    );

    expect(await connection.query("SELECT ?", [1])).toEqual([[{ id: 1 }], []]);
    expect(await connection.execute("SELECT ?", [2])).toEqual([
      [{ id: 2 }],
      [],
    ]);
    await connection.close();

    expect(closed).toEqual(true);
    expect(calls).toEqual([
      { method: "query", text: "SELECT ?", values: [1] },
      { method: "execute", text: "SELECT ?", values: [2] },
    ]);
  });
});
