const assert = require("node:assert/strict");
const test = require("node:test");

const {
  compilePostgresqlDeleteById,
  compilePostgresqlDeleteAll,
  compilePostgresqlExistsById,
  compilePostgresqlFindAll,
  compilePostgresqlFindById,
  compilePostgresqlInsert,
  compilePostgresqlCount,
  compilePostgresqlQuery,
  compilePostgresqlRawQuery,
  compilePostgresqlUpdate,
  compilePostgresqlVersionedUpdate,
  createPostgresqlDerivedQueryRepository,
  PostgresqlConnection,
  postgresql,
} = require("../dist");
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

class PgProduct {}

Id({ name: "product_id" })(PgProduct.prototype, "id");
Column({ name: "product_name" })(PgProduct.prototype, "name");
Column()(PgProduct.prototype, "price");
Version({ name: "lock_version" })(PgProduct.prototype, "version");
Entity({ name: "products" })(PgProduct);

class PgProductRepository extends NPARepository {
  repositoryName() {
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

class TestTransactionManager extends AbstractTransactionManager {
  acquireTransactionResource() {
    return {};
  }

  beginTransaction() {}

  commitTransaction() {}

  rollbackTransaction() {}
}

test("compiles a derived query method into parameterized PostgreSQL SQL", () => {
  assert.deepEqual(
    compilePostgresqlQuery(
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
    ),
    {
      text:
        'SELECT * FROM "users" WHERE ("name" LIKE $1 AND "age" > $2) ORDER BY "created_at" DESC LIMIT 2',
      values: ["%kim%", 20],
    },
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod(
          "findDistinctTop2ByNameContainingIgnoreCaseAndEmailAllIgnoreCaseOrderByNameAscAgeDesc",
        ),
        args: ["KIM", "A@EXAMPLE.COM"],
      },
      { tableName: "users" },
    ),
    {
      text:
        'SELECT DISTINCT * FROM "users" WHERE (LOWER("name") LIKE $1 AND LOWER("email") = $2) ORDER BY "name" ASC, "age" DESC LIMIT 2',
      values: ["%kim%", "a@example.com"],
    },
  );
});

test("preserves AND precedence by grouping OR predicate parts", () => {
  const compiled = compilePostgresqlQuery(
    {
      query: parseQueryMethod("findByNameOrAgeGreaterThanAndActiveTrue"),
      args: ["kim", 20],
    },
    { tableName: "users" },
  );

  assert.deepEqual(compiled, {
    text:
      'SELECT * FROM "users" WHERE ("name" = $1) OR ("age" > $2 AND "active" IS TRUE)',
    values: ["kim", 20],
  });
});

test("compiles PostgreSQL null and empty-list derived query parameters", () => {
  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("findByName"),
        args: [null],
      },
      { tableName: "users" },
    ),
    {
      text: 'SELECT * FROM "users" WHERE ("name" IS NULL)',
      values: [],
    },
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("findByNameNot"),
        args: [null],
      },
      { tableName: "users" },
    ),
    {
      text: 'SELECT * FROM "users" WHERE ("name" IS NOT NULL)',
      values: [],
    },
  );

  assert.throws(
    () =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByStatusIn"),
          args: [[]],
        },
        { tableName: "users" },
      ),
    /expects a non-empty array parameter/,
  );

  assert.throws(
    () =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByStatusNotIn"),
          args: [[]],
        },
        { tableName: "users" },
      ),
    /expects a non-empty array parameter/,
  );

  assert.throws(
    () =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByName"),
          args: [undefined],
        },
        { tableName: "users" },
      ),
    /must not be undefined/,
  );
});

test("compiles PostgreSQL derived queries across relation fields", () => {
  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("findByTeam"),
        args: [{ id: 7, label: "platform" }],
      },
      { entity: PgMember },
    ),
    {
      text:
        'SELECT * FROM "members" WHERE ("team_id" = $1)',
      values: [7],
    },
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("findByTeamIn"),
        args: [[{ id: 7, label: "platform" }, { id: 8, label: "infra" }]],
      },
      { entity: PgMember },
    ),
    {
      text:
        'SELECT * FROM "members" WHERE ("team_id" = ANY($1))',
      values: [[7, 8]],
    },
  );

  assert.throws(
    () =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeam"),
          args: [{ label: "platform" }],
        },
        { entity: PgMember },
      ),
    /Relation team requires PgTeam.id or team_id/,
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("findByTeamLabelAndNameOrderByTeamLabelDesc"),
        args: ["platform", "kim"],
      },
      { entity: PgMember },
    ),
    {
      text:
        'SELECT "npa_0".* FROM "members" AS "npa_0" JOIN "teams" AS "npa_1" ON "npa_0"."team_id" = "npa_1"."team_id" WHERE ("npa_1"."label" = $1 AND "npa_0"."name" = $2) ORDER BY "npa_1"."label" DESC',
      values: ["platform", "kim"],
    },
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("countByMembersName"),
        args: ["kim"],
      },
      { entity: PgTeam },
    ),
    {
      text:
        'SELECT COUNT(*)::int AS "count" FROM "teams" AS "npa_0" JOIN "members" AS "npa_1" ON "npa_1"."team_id" = "npa_0"."team_id" WHERE ("npa_1"."name" = $1)',
      values: ["kim"],
    },
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("countDistinctByTeamLabelIgnoreCase"),
        args: ["PLATFORM"],
      },
      { entity: PgMember },
    ),
    {
      text:
        'SELECT COUNT(DISTINCT "npa_0"."member_id")::int AS "count" FROM "members" AS "npa_0" JOIN "teams" AS "npa_1" ON "npa_0"."team_id" = "npa_1"."team_id" WHERE (LOWER("npa_1"."label") = $1)',
      values: ["platform"],
    },
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("findByRolesName"),
        args: ["admin"],
      },
      { entity: PgMember },
    ),
    {
      text:
        'SELECT "npa_0".* FROM "members" AS "npa_0" JOIN "member_roles" AS "npa_2" ON "npa_2"."pg_member_member_id" = "npa_0"."member_id" JOIN "roles" AS "npa_1" ON "npa_1"."role_id" = "npa_2"."pg_role_role_id" WHERE ("npa_1"."name" = $1)',
      values: ["admin"],
    },
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("deleteByTeamLabel"),
        args: ["platform"],
      },
      { entity: PgMember },
    ),
    {
      text:
        'DELETE FROM "members" AS "npa_0" USING "teams" AS "npa_1" WHERE "npa_0"."team_id" = "npa_1"."team_id" AND ("npa_1"."label" = $1)',
      values: ["platform"],
    },
  );
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
      queryable,
      tableName: "users",
      columns: {
        createdAt: "created_at",
      },
    },
  );

  assert.deepEqual(await repository.findOneByName("kim alpha"), {
    id: 1,
    name: "kim alpha",
    created_at: 3,
  });
  assert.equal(
    await repository.existsByActiveFalseAndNameStartingWith("kim"),
    true,
  );
  assert.equal(await repository.countByAgeBetween(20, 40), 2);
  assert.equal(await repository.deleteByStatusIn(["inactive", "blocked"]), 2);

  assert.deepEqual(calls, [
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
    adapter: postgresql({ queryable }),
    repositories: [PgProductRepository],
  });
  const products = npa.get(PgProductRepository);

  assert.equal(products instanceof PgProductRepository, true);
  assert.equal(products.repositoryName(), "pg-products");
  assert.deepEqual(await products.findById(10), {
    product_id: 10,
    product_name: "desk",
  });
  assert.deepEqual(await products.findByName("desk"), [
    { product_id: "desk", product_name: "desk" },
  ]);

  assert.deepEqual(calls, [
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

  assert.deepEqual(
    compilePostgresqlInsert(
      { id: undefined, name: "kim", age: 20, createdAt: 3 },
      options,
    ),
    {
      text:
        'INSERT INTO "users" ("name", "age", "created_at") VALUES ($1, $2, $3) RETURNING *',
      values: ["kim", 20, 3],
    },
  );
  assert.deepEqual(
    compilePostgresqlUpdate(
      1,
      { id: 1, name: "lee", createdAt: 4 },
      options,
    ),
    {
      text:
        'UPDATE "users" SET "name" = $1, "created_at" = $2 WHERE "id" = $3 RETURNING *',
      values: ["lee", 4, 1],
    },
  );
  assert.throws(
    () => compilePostgresqlUpdate(1, { id: 1 }, options),
    /without changed values/,
  );
  assert.throws(
    () =>
      compilePostgresqlVersionedUpdate(
        1,
        { id: 1, version: 2 },
        2,
        { entity: PgProduct },
      ),
    /without changed values/,
  );
  assert.deepEqual(
    compilePostgresqlUpdate(
      1,
      { displayName: "kim" },
      {
        tableName: 'audit.user"events',
        columns: {
          displayName: 'display"name',
        },
      },
    ),
    {
      text:
        'UPDATE "audit"."user""events" SET "display""name" = $1 WHERE "id" = $2 RETURNING *',
      values: ["kim", 1],
    },
  );
  assert.deepEqual(compilePostgresqlDeleteById(1, options), {
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

  assert.deepEqual(compilePostgresqlFindById(1, options), {
    text: 'SELECT * FROM "users" WHERE "id" = $1 LIMIT 1',
    values: [1],
  });
  assert.deepEqual(compilePostgresqlExistsById(1, options), {
    text:
      'SELECT EXISTS(SELECT 1 FROM "users" WHERE "id" = $1) AS "exists"',
    values: [1],
  });
  assert.deepEqual(compilePostgresqlFindAll(options), {
    text: 'SELECT * FROM "users"',
    values: [],
  });
  assert.deepEqual(compilePostgresqlCount(options), {
    text: 'SELECT COUNT(*)::int AS "count" FROM "users"',
    values: [],
  });
  assert.deepEqual(compilePostgresqlDeleteAll(options), {
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

  class RawProductRepository extends NPARepository {}

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
    { entity: PgProduct, queryable },
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

  class RawProductRepository extends NPARepository {}

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
    { entity: PgProduct, queryable },
  );

  assert.deepEqual(await repository.findProductsRaw(), []);
  assert.equal(await repository.findOneProductRaw(1), null);
  assert.equal(await repository.countEmptyRaw(), null);
  assert.equal(await repository.countNullRaw(), null);
  assert.equal(await repository.touchProductsRaw(), 0);
});

test("binds raw PostgreSQL named and positional parameters safely", () => {
  assert.deepEqual(
    compilePostgresqlRawQuery(
      'SELECT :id::int AS id, \':id\' AS literal WHERE "owner_id" = :id AND "status" = :status',
      [7, "active"],
      "findRaw",
    ),
    {
      text:
        'SELECT $1::int AS id, \':id\' AS literal WHERE "owner_id" = $1 AND "status" = $2',
      values: [7, "active"],
    },
  );

  assert.deepEqual(
    compilePostgresqlRawQuery(
      "SELECT ? AS value, '?' AS literal",
      [1],
      "findRaw",
    ),
    {
      text: "SELECT $1 AS value, '?' AS literal",
      values: [1],
    },
  );

  assert.throws(
    () =>
      compilePostgresqlRawQuery(
        "SELECT :id, :status",
        [7],
        "findRaw",
      ),
    /uses named parameter/,
  );
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
      queryable,
      tableName: "users",
      columns: {
        createdAt: "created_at",
      },
    },
  );

  assert.deepEqual(await repository.insert({ name: "kim", createdAt: 3 }), {
    id: 3,
    name: "kim",
    created_at: 3,
  });
  assert.deepEqual(await repository.save({ name: "park" }), {
    id: "park",
    name: "park",
    created_at: 3,
  });
  assert.deepEqual(await repository.updateById(1, { name: "lee" }), {
    id: 1,
    name: "lee",
    created_at: 3,
  });
  assert.deepEqual(await repository.save({ id: 2, name: "choi" }), {
    id: 2,
    name: "choi",
    created_at: 3,
  });
  assert.deepEqual(await repository.findById(1), {
    id: 1,
    name: "kim",
    created_at: 3,
  });
  assert.equal(await repository.existsById(1), true);
  assert.deepEqual(await repository.findAll(), [
    { id: 1, name: "kim", created_at: 3 },
  ]);
  assert.equal(await repository.count(), 1);
  assert.equal(await repository.deleteById(2), 1);
  assert.equal(await repository.delete({ id: 3, name: "kim" }), 1);
  assert.equal(await repository.deleteAll(), 1);

  assert.deepEqual(calls, [
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
    { entity: PgMember, queryable },
  );
  const teams = createPostgresqlDerivedQueryRepository(
    {},
    { entity: PgTeam, queryable },
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
    { entity: PgProduct, queryable },
  );
  const manager = new TestTransactionManager();

  await manager.transactional(async () => {
    const productEntity = await repository.findById(1);
    productEntity.name = "chair";
    productEntity.price = 12;
  });

  assert.deepEqual(calls, [
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
  const connection = new PostgresqlConnection(driverConnection);

  assert.deepEqual(await connection.query("SELECT $1", [1]), {
    rows: [{ id: 1 }],
    rowCount: 1,
  });
  await connection.close();

  assert.equal(closed, true);
  assert.deepEqual(calls, [{ text: "SELECT $1", values: [1] }]);
});
