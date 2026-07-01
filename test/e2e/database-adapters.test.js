const assert = require("node:assert/strict");
const test = require("node:test");

const {
  Column,
  Entity,
  Id,
  ManyToOne,
  NPATransactionIsolation,
  OneToMany,
  Transaction,
} = require("../../dist");
const {
  assertRepositoryContract,
  createProductEntity,
  databaseAdapters,
  runDatabaseFlow,
  startContainerOrSkip,
  uniqueTableName,
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
    `runs ${adapter.name} relation-field derived queries against a real database`,
    { timeout: 240_000 },
    async (t) => {
      const teamTableName = uniqueTableName(`${adapter.tablePrefix}_teams`);
      const memberTableName = uniqueTableName(`${adapter.tablePrefix}_members`);
      const container = await startContainerOrSkip(t, adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      t.after(async () => {
        try {
          if (queryable) {
            await adapter.executeSql(
              queryable,
              `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(memberTableName)}`,
            );
            await adapter.executeSql(
              queryable,
              `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(teamTableName)}`,
            );
          }
        } finally {
          if (queryable) {
            await adapter.closeQueryable(queryable);
          }
          await container.stop();
        }
      });

      queryable = await adapter.createQueryable(container);
      await adapter.executeSql(queryable, createTeamTableSql(adapter, teamTableName));
      await adapter.executeSql(queryable, createMemberTableSql(adapter, memberTableName));

      const { Team, Member } = createTeamMemberEntities(teamTableName, memberTableName);
      const teams = adapter.createRepository({ entity: Team, queryable });
      const members = adapter.createRepository({ entity: Member, queryable });

      const platform = await teams.insert({ label: "platform" });
      const design = await teams.insert({ label: "design" });
      const platformId = platform.team_id;
      const designId = design.team_id;

      await members.insert({ name: "kim", team: { id: platformId } });
      await members.insert({ name: "lee", team: { id: designId } });

      const matched = await members.findByTeamLabelAndName("platform", "kim");
      assert.deepEqual(matched.map((row) => row.name), ["kim"]);
      assert.equal(await teams.countByMembersName("kim"), 1);
      assert.equal(await members.existsByTeamLabel("design"), true);
      assert.equal(await members.deleteByTeamLabel("design"), 1);
      assert.equal(await members.existsByTeamLabel("design"), false);
    },
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

function createTeamMemberEntities(teamTableName, memberTableName) {
  class Team {}
  class Member {}

  Id({ name: "team_id" })(Team.prototype, "id");
  Column()(Team.prototype, "label");
  OneToMany(() => Member, { mappedBy: "team" })(Team.prototype, "members");
  Entity({ name: teamTableName })(Team);

  Id({ name: "member_id" })(Member.prototype, "id");
  Column()(Member.prototype, "name");
  ManyToOne(() => Team, { joinColumn: "team_id" })(Member.prototype, "team");
  Entity({ name: memberTableName })(Member);

  return { Team, Member };
}

function createTeamTableSql(adapter, tableName) {
  const table = adapter.quoteIdentifier(tableName);

  if (adapter.adapterName === "mysql") {
    return `
      CREATE TABLE ${table} (
        team_id INT AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(255) NOT NULL
      )
    `;
  }

  return `
    CREATE TABLE ${table} (
      team_id SERIAL PRIMARY KEY,
      label TEXT NOT NULL
    )
  `;
}

function createMemberTableSql(adapter, tableName) {
  const table = adapter.quoteIdentifier(tableName);

  if (adapter.adapterName === "mysql") {
    return `
      CREATE TABLE ${table} (
        member_id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        team_id INT NULL
      )
    `;
  }

  return `
    CREATE TABLE ${table} (
      member_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      team_id INTEGER NULL
    )
  `;
}
