import { compilePostgresqlDeleteById, compilePostgresqlDeleteAll, compilePostgresqlExistsById, compilePostgresqlFindAll, compilePostgresqlFindById, compilePostgresqlInsert, compilePostgresqlCount, compilePostgresqlQuery, compilePostgresqlRawQuery, compilePostgresqlUpdate, compilePostgresqlVersionedUpdate, createPostgresqlDerivedQueryRepository, PostgresqlConnection, postgresql, type PostgresqlDriverConnection, type PostgresqlQueryable } from "../src";
import { AbstractTransactionManager, Column, CreatedAt, Entity, Id, ManyToMany, ManyToOne, NPARepository, OneToMany, Query, Repository, UpdatedAt, Version, createNPA, parseQueryMethod } from "../../../src";
import { describe, expect, test } from "@jest/globals";

type DynamicRepository = Record<string, (...args: unknown[]) => unknown>;

function asPgQueryable(queryable: unknown): PostgresqlQueryable {
  return queryable as PostgresqlQueryable;
}

class PgProduct {
  id!: number;
  name!: string;
  price!: number;
  version!: number;
}

Id({ name: "product_id" })(PgProduct.prototype, "id");
Column({ name: "product_name" })(PgProduct.prototype, "name");
Column()(PgProduct.prototype, "price");
Version({ name: "lock_version" })(PgProduct.prototype, "version");
Entity({ name: "products" })(PgProduct);

class PgPlainProduct {
  id!: number;
  name!: string;
}

Id({ name: "product_id" })(PgPlainProduct.prototype, "id");
Column({ name: "product_name" })(PgPlainProduct.prototype, "name");
Entity({ name: "products" })(PgPlainProduct);

class PgTimestampedProduct {
  id!: number;
  name!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

Id({ name: "product_id" })(PgTimestampedProduct.prototype, "id");
Column({ name: "product_name" })(PgTimestampedProduct.prototype, "name");
CreatedAt({ name: "created_at" })(PgTimestampedProduct.prototype, "createdAt");
UpdatedAt({ name: "updated_at" })(PgTimestampedProduct.prototype, "updatedAt");
Entity({ name: "products" })(PgTimestampedProduct);

abstract class PgProductRepository extends NPARepository<PgProduct, number> {
  repositoryName(): string {
    return "pg-products";
  }
}

Repository(PgProduct)(PgProductRepository);

class PgTeam {}
Id({ name: "team_id" })(PgTeam.prototype, "id");
Column()(PgTeam.prototype, "label");
OneToMany(() => PgMember, { mappedBy: "team" })(PgTeam.prototype, "members");
Entity({ name: "teams" })(PgTeam);

class PgRole {}
Id({ name: "role_id" })(PgRole.prototype, "id");
Column()(PgRole.prototype, "name");
Entity({ name: "roles" })(PgRole);

class PgMember {}
Id({ name: "member_id" })(PgMember.prototype, "id");
Column()(PgMember.prototype, "name");
ManyToOne(() => PgTeam, { joinColumn: "team_id" })(PgMember.prototype, "team");
ManyToMany(() => PgRole, { joinTable: "member_roles" })(PgMember.prototype, "roles");
Entity({ name: "members" })(PgMember);

class PgBrokenTeam {}
Id({ name: "team_id" })(PgBrokenTeam.prototype, "id");
Column()(PgBrokenTeam.prototype, "label");
OneToMany(() => PgBrokenMember)(PgBrokenTeam.prototype, "members");
Entity({ name: "broken_teams" })(PgBrokenTeam);

class PgBrokenMember {}
Id({ name: "member_id" })(PgBrokenMember.prototype, "id");
Column()(PgBrokenMember.prototype, "name");
Entity({ name: "broken_members" })(PgBrokenMember);

class TestTransactionManager extends AbstractTransactionManager<object> {
  protected acquireTransactionResource() {
    return {};
  }

  protected beginTransaction() {}

  protected commitTransaction() {}

  protected rollbackTransaction() {}
}
describe("PostgreSQL adapter", () => {
  test("compiles a derived query method into parameterized PostgreSQL SQL", () => {
    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod(
            "findTop2ByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc",
          ),
          args: ["kim", 20],
        },
        {
          tableName: "users",
          columns: {
            createdAt: "created_at",
          },
        },
      )).toEqual({
        text:
          'SELECT * FROM "users" WHERE ("name" LIKE $1 AND "age" > $2) ORDER BY "created_at" DESC LIMIT 2',
        values: ["%kim%", 20],
      });

    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod(
            "findDistinctTop2ByNameContainingIgnoreCaseAndEmailAllIgnoreCaseOrderByNameAscAgeDesc",
          ),
          args: ["KIM", "A@EXAMPLE.COM"],
        },
        { tableName: "users" },
      )).toEqual({
        text:
          'SELECT DISTINCT * FROM "users" WHERE (LOWER("name") LIKE $1 AND LOWER("email") = $2) ORDER BY "name" ASC, "age" DESC LIMIT 2',
        values: ["%kim%", "a@example.com"],
      });
  });

  test("preserves AND precedence by grouping OR predicate parts", () => {
    const compiled = compilePostgresqlQuery(
      {
        query: parseQueryMethod("findByNameOrAgeGreaterThanAndActiveTrue"),
        args: ["kim", 20],
      },
      { tableName: "users" },
    );

    expect(compiled).toEqual({
      text:
        'SELECT * FROM "users" WHERE ("name" = $1) OR ("age" > $2 AND "active" IS TRUE)',
      values: ["kim", 20],
    });
  });

  test("compiles PostgreSQL null and empty-list derived query parameters", () => {
    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByName"),
          args: [null],
        },
        { tableName: "users" },
      )).toEqual({
        text: 'SELECT * FROM "users" WHERE ("name" IS NULL)',
        values: [],
      });

    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByNameNot"),
          args: [null],
        },
        { tableName: "users" },
      )).toEqual({
        text: 'SELECT * FROM "users" WHERE ("name" IS NOT NULL)',
        values: [],
      });

    expect(() =>
        compilePostgresqlQuery(
          {
            query: parseQueryMethod("findByStatusIn"),
            args: [[]],
          },
          { tableName: "users" },
        )).toThrow(/expects a non-empty array parameter/);

    expect(() =>
        compilePostgresqlQuery(
          {
            query: parseQueryMethod("findByStatusNotIn"),
            args: [[]],
          },
          { tableName: "users" },
        )).toThrow(/expects a non-empty array parameter/);

    expect(() =>
        compilePostgresqlQuery(
          {
            query: parseQueryMethod("findByName"),
            args: [undefined],
          },
          { tableName: "users" },
        )).toThrow(/must not be undefined/);
  });

  test("compiles PostgreSQL derived queries across relation fields", () => {
    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeam"),
          args: [{ id: 7, label: "platform" }],
        },
        { entity: PgMember },
      )).toEqual({
        text:
          'SELECT * FROM "members" WHERE ("team_id" = $1)',
        values: [7],
      });

    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeamIn"),
          args: [[{ id: 7, label: "platform" }, { id: 8, label: "infra" }]],
        },
        { entity: PgMember },
      )).toEqual({
        text:
          'SELECT * FROM "members" WHERE ("team_id" = ANY($1))',
        values: [[7, 8]],
      });

    expect(() =>
        compilePostgresqlQuery(
          {
            query: parseQueryMethod("findByTeam"),
            args: [{ label: "platform" }],
          },
          { entity: PgMember },
        )).toThrow(/Relation team requires PgTeam.id or team_id/);

    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeamLabelAndNameOrderByTeamLabelDesc"),
          args: ["platform", "kim"],
        },
        { entity: PgMember },
      )).toEqual({
        text:
          'SELECT "npa_0".* FROM "members" AS "npa_0" JOIN "teams" AS "npa_1" ON "npa_0"."team_id" = "npa_1"."team_id" WHERE ("npa_1"."label" = $1 AND "npa_0"."name" = $2) ORDER BY "npa_1"."label" DESC',
        values: ["platform", "kim"],
      });

    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("countByMembersName"),
          args: ["kim"],
        },
        { entity: PgTeam },
      )).toEqual({
        text:
          'SELECT COUNT(*)::int AS "count" FROM "teams" AS "npa_0" JOIN "members" AS "npa_1" ON "npa_1"."team_id" = "npa_0"."team_id" WHERE ("npa_1"."name" = $1)',
        values: ["kim"],
      });

    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("countDistinctByTeamLabelIgnoreCase"),
          args: ["PLATFORM"],
        },
        { entity: PgMember },
      )).toEqual({
        text:
          'SELECT COUNT(DISTINCT "npa_0"."member_id")::int AS "count" FROM "members" AS "npa_0" JOIN "teams" AS "npa_1" ON "npa_0"."team_id" = "npa_1"."team_id" WHERE (LOWER("npa_1"."label") = $1)',
        values: ["platform"],
      });

    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByRolesName"),
          args: ["admin"],
        },
        { entity: PgMember },
      )).toEqual({
        text:
          'SELECT "npa_0".* FROM "members" AS "npa_0" JOIN "member_roles" AS "npa_2" ON "npa_2"."pg_member_member_id" = "npa_0"."member_id" JOIN "roles" AS "npa_1" ON "npa_1"."role_id" = "npa_2"."pg_role_role_id" WHERE ("npa_1"."name" = $1)',
        values: ["admin"],
      });

    expect(() =>
        compilePostgresqlQuery(
          {
            query: parseQueryMethod("findByRolesMissing"),
            args: ["admin"],
          },
          { entity: PgMember },
        )).toThrow(/Relation query PgMember\.rolesMissing targets PgRole\.missing, but that property is not a column/);

    expect(() =>
        compilePostgresqlQuery(
          {
            query: parseQueryMethod("findByMembersName"),
            args: ["kim"],
          },
          { entity: PgBrokenTeam },
        )).toThrow(/@OneToMany PgBrokenTeam\.members requires mappedBy/);

    expect(compilePostgresqlQuery(
        {
          query: parseQueryMethod("deleteByTeamLabel"),
          args: ["platform"],
        },
        { entity: PgMember },
      )).toEqual({
        text:
          'DELETE FROM "members" AS "npa_0" USING "teams" AS "npa_1" WHERE "npa_0"."team_id" = "npa_1"."team_id" AND ("npa_1"."label" = $1)',
        values: ["platform"],
      });
  });

  test("runs findOne, exists, count, and delete through a PostgreSQL queryable", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("SELECT EXISTS")) {
          return { rows: [{ exists: true }], rowCount: 1 };
        }

        if (text.startsWith("SELECT COUNT")) {
          return { rows: [{ count: 2 }], rowCount: 1 };
        }

        if (text.startsWith("DELETE")) {
          return { rows: [], rowCount: 2 };
        }

        return {
          rows: [{ id: 1, name: "kim alpha", created_at: 3 }],
          rowCount: 1,
        };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      {
        queryable: asPgQueryable(queryable),
        tableName: "users",
        columns: {
          createdAt: "created_at",
        },
      },
    ) as NPARepository<Record<string, unknown>, unknown> & DynamicRepository;

    expect(await repository.findOneByName("kim alpha")).toEqual({
      id: 1,
      name: "kim alpha",
      created_at: 3,
    });
    expect(await repository.existsByActiveFalseAndNameStartingWith("kim")).toEqual(true);
    expect(await repository.countByAgeBetween(20, 40)).toEqual(2);
    expect(await repository.deleteByStatusIn(["inactive", "blocked"])).toEqual(2);

    expect(calls).toEqual([
      {
        text: 'SELECT * FROM "users" WHERE ("name" = $1) LIMIT 1',
        values: ["kim alpha"],
      },
      {
        text:
          'SELECT EXISTS(SELECT 1 FROM "users" WHERE ("active" IS FALSE AND "name" LIKE $1)) AS "exists"',
        values: ["kim%"],
      },
      {
        text:
          'SELECT COUNT(*)::int AS "count" FROM "users" WHERE ("age" BETWEEN $1 AND $2)',
        values: [20, 40],
      },
      {
        text: 'DELETE FROM "users" WHERE ("status" = ANY($1))',
        values: [["inactive", "blocked"]],
      },
    ]);
  });

  test("creates PostgreSQL repositories from @Repository tokens", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        return {
          rows: [{ product_id: values[0], product_name: "desk" }],
          rowCount: 1,
        };
      },
    };
    const npa = createNPA({
      adapter: postgresql({ queryable: asPgQueryable(queryable) }),
      repositories: [PgProductRepository],
    });
    const products = npa.get(PgProductRepository) as PgProductRepository & DynamicRepository;

    expect(products instanceof PgProductRepository).toEqual(true);
    expect(products.repositoryName()).toEqual("pg-products");
    expect(await products.findById(10)).toEqual({
      product_id: 10,
      product_name: "desk",
    });
    expect(await products.findByName("desk")).toEqual([
      { product_id: "desk", product_name: "desk" },
    ]);

    expect(calls).toEqual([
      {
        text: 'SELECT * FROM "products" WHERE "product_id" = $1 LIMIT 1',
        values: [10],
      },
      {
        text: 'SELECT * FROM "products" WHERE ("product_name" = $1)',
        values: ["desk"],
      },
    ]);
  });

  test("compiles insert, update, and deleteById PostgreSQL CRUD SQL", () => {
    const options = {
      tableName: "users",
      columns: {
        createdAt: "created_at",
      },
    };

    expect(compilePostgresqlInsert(
        { id: undefined, name: "kim", age: 20, createdAt: 3 },
        options,
      )).toEqual({
        text:
          'INSERT INTO "users" ("name", "age", "created_at") VALUES ($1, $2, $3) RETURNING *',
        values: ["kim", 20, 3],
      });
    expect(compilePostgresqlUpdate(
        1,
        { id: 1, name: "lee", createdAt: 4 },
        options,
      )).toEqual({
        text:
          'UPDATE "users" SET "name" = $1, "created_at" = $2 WHERE "id" = $3 RETURNING *',
        values: ["lee", 4, 1],
      });
    expect(() => compilePostgresqlUpdate(1, { id: 1 }, options)).toThrow(/without changed values/);
    expect(() =>
        compilePostgresqlVersionedUpdate(
          1,
          { id: 1, version: 2 },
          2,
          { entity: PgProduct },
        )).toThrow(/without changed values/);
    expect(compilePostgresqlUpdate(
        1,
        { displayName: "kim" },
        {
          tableName: 'audit.user"events',
          columns: {
            displayName: 'display"name',
          },
        },
      )).toEqual({
        text:
          'UPDATE "audit"."user""events" SET "display""name" = $1 WHERE "id" = $2 RETURNING *',
        values: ["kim", 1],
      });
    expect(compilePostgresqlDeleteById(1, options)).toEqual({
      text: 'DELETE FROM "users" WHERE "id" = $1',
      values: [1],
    });
  });

  test("compiles JPA-style PostgreSQL repository SQL", () => {
    const options = {
      tableName: "users",
      columns: {
        createdAt: "created_at",
      },
    };

    expect(compilePostgresqlFindById(1, options)).toEqual({
      text: 'SELECT * FROM "users" WHERE "id" = $1 LIMIT 1',
      values: [1],
    });
    expect(compilePostgresqlExistsById(1, options)).toEqual({
      text:
        'SELECT EXISTS(SELECT 1 FROM "users" WHERE "id" = $1) AS "exists"',
      values: [1],
    });
    expect(compilePostgresqlFindAll(options)).toEqual({
      text: 'SELECT * FROM "users"',
      values: [],
    });
    expect(compilePostgresqlCount(options)).toEqual({
      text: 'SELECT COUNT(*)::int AS "count" FROM "users"',
      values: [],
    });
    expect(compilePostgresqlDeleteAll(options)).toEqual({
      text: 'DELETE FROM "users"',
      values: [],
    });
  });

  test("executes @Query raw PostgreSQL repository methods", async () => {
    const calls = [];
    const queryable = {
      query(text, values = []) {
        calls.push({ text, values });

        if (text.startsWith("SELECT COUNT")) {
          return { rows: [{ total: "2" }], rowCount: 1 };
        }

        if (text.startsWith("UPDATE")) {
          return { rows: [], rowCount: 3 };
        }

        return {
          rows: [{ product_id: values[0] ?? 1, product_name: "desk" }],
          rowCount: 1,
        };
      },
    };

    abstract class RawProductRepository extends NPARepository<PgProduct, number> {}

    Query('SELECT * FROM "products" WHERE "price" > :minPrice', { result: "many" })(
      RawProductRepository.prototype,
      "findExpensiveProducts",
    );
    Query('SELECT * FROM "products" WHERE "product_id" = :id', { result: "one" })(
      RawProductRepository.prototype,
      "findOneProductRaw",
    );
    Query('SELECT COUNT(*) AS total FROM "products" WHERE "price" > :minPrice', { result: "scalar" })(
      RawProductRepository.prototype,
      "countProductsRaw",
    );
    Query('UPDATE "products" SET "price" = "price" + :amount WHERE "price" < :amount', { result: "execute" })(
      RawProductRepository.prototype,
      "raisePricesRaw",
    );

    const repository = createPostgresqlDerivedQueryRepository(
      Object.create(RawProductRepository.prototype),
      { entity: PgProduct, queryable: asPgQueryable(queryable) },
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
        text: 'SELECT * FROM "products" WHERE "price" > $1',
        values: [100],
      },
      {
        text: 'SELECT * FROM "products" WHERE "product_id" = $1',
        values: [7],
      },
      {
        text: 'SELECT COUNT(*) AS total FROM "products" WHERE "price" > $1',
        values: [10],
      },
      {
        text: 'UPDATE "products" SET "price" = "price" + $1 WHERE "price" < $1',
        values: [5],
      },
    ]);
  });

  test("handles empty and null @Query raw PostgreSQL results", async () => {
    const queryable = {
      query(text) {
        if (text.includes("COUNT_EMPTY")) {
          return { rows: [], rowCount: 0 };
        }

        if (text.includes("COUNT_NULL")) {
          return { rows: [{ total: null }], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      },
    };

    abstract class RawProductRepository extends NPARepository<PgProduct, number> {}

    Query('SELECT * FROM "products"', { result: "many" })(
      RawProductRepository.prototype,
      "findProductsRaw",
    );
    Query('SELECT * FROM "products" WHERE "product_id" = :id', { result: "one" })(
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
    Query('UPDATE "products" SET "price" = "price"', { result: "execute" })(
      RawProductRepository.prototype,
      "touchProductsRaw",
    );

    const repository = createPostgresqlDerivedQueryRepository(
      Object.create(RawProductRepository.prototype),
      { entity: PgProduct, queryable: asPgQueryable(queryable) },
    ) as DynamicRepository;

    expect(await repository.findProductsRaw()).toEqual([]);
    expect(await repository.findOneProductRaw(1)).toEqual(null);
    expect(await repository.countEmptyRaw()).toEqual(null);
    expect(await repository.countNullRaw()).toEqual(null);
    expect(await repository.touchProductsRaw()).toEqual(0);
  });

  test("binds raw PostgreSQL named and positional parameters safely", () => {
    expect(compilePostgresqlRawQuery(
        'SELECT :id::int AS id, \':id\' AS literal WHERE "owner_id" = :id AND "status" = :status',
        [7, "active"],
        "findRaw",
      )).toEqual({
        text:
          'SELECT $1::int AS id, \':id\' AS literal WHERE "owner_id" = $1 AND "status" = $2',
        values: [7, "active"],
      });

    expect(compilePostgresqlRawQuery(
        "SELECT ? AS value, '?' AS literal",
        [1],
        "findRaw",
      )).toEqual({
        text: "SELECT $1 AS value, '?' AS literal",
        values: [1],
      });

    expect(() =>
        compilePostgresqlRawQuery(
          "SELECT :id, :status",
          [7],
          "findRaw",
        )).toThrow(/uses named parameter/);
  });

  test("runs save, insert, updateById, and deleteById through a PostgreSQL queryable", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("SELECT EXISTS")) {
          return { rows: [{ exists: true }], rowCount: 1 };
        }

        if (text.startsWith("SELECT COUNT")) {
          return { rows: [{ count: 1 }], rowCount: 1 };
        }

        if (text === 'SELECT * FROM "users"') {
          return {
            rows: [{ id: 1, name: "kim", created_at: 3 }],
            rowCount: 1,
          };
        }

        if (text.startsWith('SELECT * FROM "users" WHERE')) {
          return {
            rows: [{ id: values[0], name: "kim", created_at: 3 }],
            rowCount: 1,
          };
        }

        if (text.startsWith("DELETE")) {
          return { rows: [], rowCount: 1 };
        }

        return {
          rows: [{ id: values.at(-1) ?? 10, name: values[0], created_at: 3 }],
          rowCount: 1,
        };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      {
        queryable: asPgQueryable(queryable),
        tableName: "users",
        columns: {
          createdAt: "created_at",
        },
      },
    );

    expect(await repository.insert({ name: "kim", createdAt: 3 })).toEqual({
      id: 3,
      name: "kim",
      created_at: 3,
    });
    expect(await repository.save({ name: "park" })).toEqual({
      id: "park",
      name: "park",
      created_at: 3,
    });
    expect(await repository.updateById(1, { name: "lee" })).toEqual({
      id: 1,
      name: "lee",
      created_at: 3,
    });
    expect(await repository.save({ id: 2, name: "choi" })).toEqual({
      id: 2,
      name: "choi",
      created_at: 3,
    });
    expect(await repository.findById(1)).toEqual({
      id: 1,
      name: "kim",
      created_at: 3,
    });
    expect(await repository.existsById(1)).toEqual(true);
    expect(await repository.findAll()).toEqual([
      { id: 1, name: "kim", created_at: 3 },
    ]);
    expect(await repository.count()).toEqual(1);
    expect(await repository.deleteById(2)).toEqual(1);
    expect(await repository.delete({ id: 3, name: "kim" })).toEqual(1);
    expect(await repository.deleteAll()).toEqual(1);

    expect(calls).toEqual([
      {
        text:
          'INSERT INTO "users" ("name", "created_at") VALUES ($1, $2) RETURNING *',
        values: ["kim", 3],
      },
      {
        text: 'INSERT INTO "users" ("name") VALUES ($1) RETURNING *',
        values: ["park"],
      },
      {
        text: 'UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING *',
        values: ["lee", 1],
      },
      {
        text: 'UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING *',
        values: ["choi", 2],
      },
      {
        text: 'SELECT * FROM "users" WHERE "id" = $1 LIMIT 1',
        values: [1],
      },
      {
        text:
          'SELECT EXISTS(SELECT 1 FROM "users" WHERE "id" = $1) AS "exists"',
        values: [1],
      },
      {
        text: 'SELECT * FROM "users"',
        values: [],
      },
      {
        text: 'SELECT COUNT(*)::int AS "count" FROM "users"',
        values: [],
      },
      {
        text: 'DELETE FROM "users" WHERE "id" = $1',
        values: [2],
      },
      {
        text: 'DELETE FROM "users" WHERE "id" = $1',
        values: [3],
      },
      {
        text: 'DELETE FROM "users"',
        values: [],
      },
    ]);
  });

  test("uses timestamp decorators for PostgreSQL insert defaults and update touches", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("INSERT")) {
          return {
            rows: [{ product_id: 1, product_name: values[0] }],
            rowCount: 1,
          };
        }

        return {
          rows: [{
            product_id: 1,
            product_name: values[0],
            updated_at: values[1],
          }],
          rowCount: 1,
        };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgTimestampedProduct, queryable: asPgQueryable(queryable) },
    ) as NPARepository<Record<string, unknown>, number>;

    await repository.insert({ name: "desk" });
    await repository.updateById(1, { name: "chair" });

    expect(calls).toEqual([
      {
        text:
          'INSERT INTO "products" ("product_name") VALUES ($1) RETURNING *',
        values: ["desk"],
      },
      {
        text:
          'UPDATE "products" SET "product_name" = $1, "updated_at" = $2 WHERE "product_id" = $3 RETURNING *',
        values: ["chair", expect.any(Date), 1],
      },
    ]);
  });

  test("uses optimistic PostgreSQL updateById SQL only for versioned entities", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        return {
          rows: [{ product_id: values.at(-2) ?? values.at(-1), product_name: values[0], lock_version: 1 }],
          rowCount: 1,
        };
      },
    };
    const versioned = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgProduct, queryable: asPgQueryable(queryable) },
    );
    const plain = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgPlainProduct, queryable: asPgQueryable(queryable) },
    );

    await versioned.updateById(1, { name: "chair", version: 0 });
    await plain.updateById(2, { name: "desk" });

    expect(calls).toEqual([
      {
        text:
          'UPDATE "products" SET "product_name" = $1, "lock_version" = "lock_version" + 1 WHERE "product_id" = $2 AND "lock_version" = $3 RETURNING *',
        values: ["chair", 1, 0],
      },
      {
        text:
          'UPDATE "products" SET "product_name" = $1 WHERE "product_id" = $2 RETURNING *',
        values: ["desk", 2],
      },
    ]);
  });

  test("loads PostgreSQL many-to-one, one-to-many, and many-to-many relations", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text === 'SELECT * FROM "members" WHERE "member_id" = $1 LIMIT 1') {
          return { rows: [{ member_id: values[0], name: "kim", team_id: 2 }], rowCount: 1 };
        }

        if (text === 'SELECT * FROM "teams" WHERE "team_id" IN ($1)') {
          return { rows: [{ team_id: 2, label: "core" }], rowCount: 1 };
        }

        if (text.includes('FROM "member_roles" j')) {
          return {
            rows: [
              { __npa_source_id: 10, role_id: 7, name: "admin" },
              { __npa_source_id: 10, role_id: 8, name: "writer" },
            ],
            rowCount: 2,
          };
        }

        if (text === 'SELECT * FROM "teams"') {
          return { rows: [{ team_id: 2, label: "core" }], rowCount: 1 };
        }

        if (text === 'SELECT * FROM "members" WHERE "team_id" IN ($1)') {
          return {
            rows: [
              { member_id: 10, name: "kim", team_id: 2 },
              { member_id: 11, name: "lee", team_id: 2 },
            ],
            rowCount: 2,
          };
        }

        throw new Error(`Unexpected query: ${text}`);
      },
    };
    const members = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgMember, queryable: asPgQueryable(queryable) },
    );
    const teams = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgTeam, queryable: asPgQueryable(queryable) },
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

  test("flushes dirty managed entities through a PostgreSQL repository", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("UPDATE")) {
          return {
            rows: [{ product_id: 1, product_name: values[0], price: values[1], lock_version: 1 }],
            rowCount: 1,
          };
        }

        return {
          rows: [{ product_id: 1, product_name: "desk", price: 10, lock_version: 0 }],
          rowCount: 1,
        };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgProduct, queryable: asPgQueryable(queryable) },
    );
    const manager = new TestTransactionManager();

    await manager.transactional(async () => {
      const productEntity = await repository.findById(1);
      productEntity.name = "chair";
      productEntity.price = 12;
    });

    expect(calls).toEqual([
      {
        text:
          'SELECT * FROM "products" WHERE "product_id" = $1 LIMIT 1',
        values: [1],
      },
      {
        text:
          'UPDATE "products" SET "product_name" = $1, "price" = $2, "lock_version" = "lock_version" + 1 WHERE "product_id" = $3 AND "lock_version" = $4 RETURNING *',
        values: ["chair", 12, 1, 0],
      },
    ]);
  });

  test("wraps a pg pool or client", async () => {
    const calls = [];
    let closed = false;
    const driverConnection = {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [{ id: 1 }], rowCount: 1 };
      },
      async end() {
        closed = true;
      },
    };
    const connection = new PostgresqlConnection(
      driverConnection as unknown as PostgresqlDriverConnection,
    );

    expect(await connection.query("SELECT $1", [1])).toEqual({
      rows: [{ id: 1 }],
      rowCount: 1,
    });
    await connection.close();

    expect(closed).toEqual(true);
    expect(calls).toEqual([{ text: "SELECT $1", values: [1] }]);
  });
});
