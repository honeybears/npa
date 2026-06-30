const assert = require("node:assert/strict");
const test = require("node:test");

const {
  Column,
  Entity,
  Id,
  Index,
  ManyToMany,
  ManyToOne,
  OneToMany,
  Unique,
  getEntityMetadata,
  parseQueryMethod,
} = require("../dist");
const {
  compilePostgresqlInsert,
  compilePostgresqlQuery,
  createPostgresqlDerivedQueryRepository,
} = require("../packages/pg/dist");

class Team {}
class Role {}
class User {}

Id({ name: "team_id" })(Team.prototype, "id");
Column()(Team.prototype, "name");
OneToMany(() => User, { mappedBy: "team" })(Team.prototype, "users");
Entity({ name: "teams" })(Team);

Id({ name: "role_id" })(Role.prototype, "id");
Column()(Role.prototype, "name");
ManyToMany(() => User, { mappedBy: "roles" })(Role.prototype, "users");
Entity({ name: "roles" })(Role);

Id({ name: "user_id" })(User.prototype, "id");
Column({ name: "full_name" })(User.prototype, "name");
Unique({ name: "uidx_users_full_name" })(User.prototype, "name");
Column({ name: "created_at", index: "idx_users_created_at" })(User.prototype, "createdAt");
Index({ name: "idx_users_name_created_at", columns: ["name", "createdAt"] })(User);
ManyToOne(() => Team, { joinColumn: "team_id" })(User.prototype, "team");
ManyToMany(() => Role, { joinTable: "user_roles" })(User.prototype, "roles");
Entity({ name: "npa_users", schema: "app" })(User);

test("registers JPA-style entity metadata including relations", () => {
  const metadata = getEntityMetadata(User);

  assert.equal(metadata.tableName, "npa_users");
  assert.equal(metadata.schema, "app");
  assert.deepEqual(
    metadata.columns.map((column) => ({
      propertyName: column.propertyName,
      columnName: column.columnName,
      primary: column.primary,
    })),
    [
      { propertyName: "id", columnName: "user_id", primary: true },
      { propertyName: "name", columnName: "full_name", primary: false },
      { propertyName: "createdAt", columnName: "created_at", primary: false },
    ],
  );
  assert.deepEqual(
    metadata.indexes.map((index) => ({
      name: index.name,
      propertyNames: index.propertyNames,
      unique: index.unique,
    })),
    [
      {
        name: "uidx_users_full_name",
        propertyNames: ["name"],
        unique: true,
      },
      {
        name: "idx_users_created_at",
        propertyNames: ["createdAt"],
        unique: false,
      },
      {
        name: "idx_users_name_created_at",
        propertyNames: ["name", "createdAt"],
        unique: false,
      },
    ],
  );
  assert.deepEqual(
    metadata.relations.map((relation) => ({
      propertyName: relation.propertyName,
      kind: relation.kind,
      joinColumn: relation.joinColumn,
      joinTable: relation.joinTable,
    })),
    [
      {
        propertyName: "team",
        kind: "many-to-one",
        joinColumn: "team_id",
        joinTable: undefined,
      },
      {
        propertyName: "roles",
        kind: "many-to-many",
        joinColumn: undefined,
        joinTable: "user_roles",
      },
    ],
  );
});

test("uses entity metadata for PostgreSQL insert and derived query mapping", () => {
  assert.deepEqual(
    compilePostgresqlInsert(
      {
        id: undefined,
        name: "kim",
        createdAt: 10,
        team: { id: 1 },
        ignored: "not a column",
      },
      { entity: User },
    ),
    {
      text:
        'INSERT INTO "app"."npa_users" ("full_name", "created_at") VALUES ($1, $2) RETURNING *',
      values: ["kim", 10],
    },
  );

  assert.deepEqual(
    compilePostgresqlQuery(
      {
        query: parseQueryMethod("findByNameAndCreatedAtGreaterThan"),
        args: ["kim", 1],
      },
      { entity: User },
    ),
    {
      text:
        'SELECT * FROM "app"."npa_users" WHERE ("full_name" = $1 AND "created_at" > $2)',
      values: ["kim", 1],
    },
  );
});

test("creates a database-agnostic NPA repository backed by the PostgreSQL adapter", async () => {
  const calls = [];
  const queryable = {
    async query(text, values) {
      calls.push({ text, values });

      return {
        rows: [{ user_id: 1, full_name: values[0], created_at: values[1] }],
        rowCount: 1,
      };
    },
  };
  const repository = createPostgresqlDerivedQueryRepository(
    {},
    { entity: User, queryable },
  );

  assert.deepEqual(await repository.insert({ name: "kim", createdAt: 10 }), {
    user_id: 1,
    full_name: "kim",
    created_at: 10,
  });
  await repository.findByName("kim");

  assert.deepEqual(calls, [
    {
      text:
        'INSERT INTO "app"."npa_users" ("full_name", "created_at") VALUES ($1, $2) RETURNING *',
      values: ["kim", 10],
    },
    {
      text: 'SELECT * FROM "app"."npa_users" WHERE ("full_name" = $1)',
      values: ["kim"],
    },
  ]);
});
