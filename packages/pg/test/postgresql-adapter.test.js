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
  compilePostgresqlUpdate,
  createPostgresqlDerivedQueryRepository,
  PostgresqlConnection,
} = require("../dist");
const {
  AbstractTransactionManager,
  Column,
  Entity,
  Id,
  Version,
  parseQueryMethod,
} = require("../../../dist");

class PgProduct {}

Id({ name: "product_id" })(PgProduct.prototype, "id");
Column({ name: "product_name" })(PgProduct.prototype, "name");
Column()(PgProduct.prototype, "price");
Version({ name: "lock_version" })(PgProduct.prototype, "version");
Entity({ name: "products" })(PgProduct);

class TestTransactionManager extends AbstractTransactionManager {
  acquireTransactionResource() {
    return {};
  }

  beginTransaction() {}

  commitTransaction() {}

  rollbackTransaction() {}
}

test("compiles a derived query method into parameterized PostgreSQL SQL", () => {
  const compiled = compilePostgresqlQuery(
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
  );

  assert.deepEqual(compiled, {
    text:
      'SELECT * FROM "users" WHERE ("name" LIKE $1 AND "age" > $2) ORDER BY "created_at" DESC LIMIT 2',
    values: ["%kim%", 20],
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

  assert.deepEqual(compiled, {
    text:
      'SELECT * FROM "users" WHERE ("name" = $1) OR ("age" > $2 AND "active" IS TRUE)',
    values: ["kim", 20],
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
