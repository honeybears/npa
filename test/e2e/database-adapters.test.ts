import { Column, Entity, Id, ManyToOne, ManyToMany, NPARepository, NPATransactionIsolation, NPATransactionPropagation, OneToMany, RollbackOnlyError, Transaction } from "../../dist";
import { assertRepositoryContract, createProductEntity, databaseAdapters, runDatabaseFlow, startContainerOrSkip, uniqueTableName } from "./database-flow";
import { describe, expect, test } from "@jest/globals";

type Row = Record<string, unknown>;
type ProductRepository = NPARepository<Row, unknown> & {
  countByStatus(status: string): Promise<number>;
  deleteByStatus(status: string): Promise<number>;
};
type RelationRepository = NPARepository<Row, unknown> & {
  countByMembersName(name: string): Promise<number>;
  countDistinctByRolesName(name: string): Promise<number>;
  deleteByTeamLabel(label: string): Promise<number>;
  existsByRolesName(name: string): Promise<boolean>;
  existsByTeamLabel(label: string): Promise<boolean>;
  findByRolesName(name: string): Promise<Row[]>;
  findByTeamIn(teams: Array<{ id: unknown }>): Promise<Row[]>;
  findByTeamLabelAndName(label: string, name: string): Promise<Row[]>;
  findByTeamLabelInOrderByTeamLabelDesc(labels: string[]): Promise<Row[]>;
};

describe("database adapter E2E", () => {
  for (const adapter of databaseAdapters) {
    test(
      `runs ${adapter.name} repository E2E against a real database`,
      () =>
        runDatabaseFlow(adapter, async ({ queryable, tableName }) => {
          const repository = adapter.createRepository({
            entity: createProductEntity(tableName),
            queryable,
          });

          await assertRepositoryContract(repository, { nullableStatus: true });
        }),
      240_000,
    );
  }

  for (const adapter of databaseAdapters) {
    test(
      `runs ${adapter.name} relation-field derived queries against a real database`,
      async () => {
        const teamTableName = uniqueTableName(`${adapter.tablePrefix}_teams`);
        const memberTableName = uniqueTableName(`${adapter.tablePrefix}_members`);
        const roleTableName = uniqueTableName(`${adapter.tablePrefix}_roles`);
        const memberRoleTableName = uniqueTableName(`${adapter.tablePrefix}_member_roles`);
        const container = await startContainerOrSkip(adapter.createContainer());

        if (!container) {
          return;
        }

        let queryable;

        try {
          queryable = await adapter.createQueryable(container);
          await adapter.executeSql(queryable, createTeamTableSql(adapter, teamTableName));
          await adapter.executeSql(queryable, createMemberTableSql(adapter, memberTableName));
          await adapter.executeSql(queryable, createRoleTableSql(adapter, roleTableName));
          await adapter.executeSql(
            queryable,
            createMemberRoleTableSql(adapter, memberRoleTableName),
          );

          const { Team, Member, Role } = createTeamMemberEntities(
            teamTableName,
            memberTableName,
            roleTableName,
            memberRoleTableName,
          );
          const teams = adapter.createRepository({ entity: Team, queryable }) as RelationRepository;
          const members = adapter.createRepository({ entity: Member, queryable }) as RelationRepository;
          const roles = adapter.createRepository({ entity: Role, queryable });

          const platform = await teams.insert({ label: "platform" });
          const design = await teams.insert({ label: "design" });
          const platformId = platform.team_id;
          const designId = design.team_id;

          const kim = await members.insert({ name: "kim", team: { id: platformId } });
          const lee = await members.insert({ name: "lee", team: { id: designId } });
          const admin = await roles.insert({ name: "admin" });
          const writer = await roles.insert({ name: "writer" });

          await adapter.executeSql(
            queryable,
            insertMemberRoleSql(adapter, memberRoleTableName, kim.member_id, admin.role_id),
          );
          await adapter.executeSql(
            queryable,
            insertMemberRoleSql(adapter, memberRoleTableName, lee.member_id, writer.role_id),
          );

          const matched = await members.findByTeamLabelAndName("platform", "kim");
          expect(matched.map((row) => row.name)).toEqual(["kim"]);
          expect(await teams.countByMembersName("kim")).toEqual(1);
          expect((await members.findByTeamIn([{ id: platformId }, { id: designId }]))
              .map((row) => row.name)
              .sort()).toEqual(["kim", "lee"]);
          expect((await members.findByTeamLabelInOrderByTeamLabelDesc(["platform", "design"]))
              .map((row) => row.name)).toEqual(["kim", "lee"]);
          expect((await members.findByRolesName("admin")).map((row) => row.name)).toEqual(["kim"]);
          expect(await members.existsByRolesName("writer")).toEqual(true);
          expect(await members.countDistinctByRolesName("admin")).toEqual(1);
          expect(await members.existsByTeamLabel("design")).toEqual(true);
          expect(await members.deleteByTeamLabel("design")).toEqual(1);
          expect(await members.existsByTeamLabel("design")).toEqual(false);
        } finally {
          try {
            if (queryable) {
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(memberRoleTableName)}`,
              );
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(memberTableName)}`,
              );
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(roleTableName)}`,
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
        }
      },
      240_000,
    );
  }

  for (const adapter of databaseAdapters) {
    test(
      `runs ${adapter.name} @Transaction E2E against a real database`,
      () =>
        runDatabaseFlow(adapter, async ({ container, tableName }) => {
          const runtime = await adapter.createTransactionRuntime(container);

          try {
            const repository = adapter.createRepository({
              entity: createProductEntity(tableName),
              queryable: runtime.queryable,
            }) as ProductRepository;
            const service = new ProductService(runtime.manager, repository);

            await assertTransactionIsolation(
              adapter,
              container,
              tableName,
              runtime,
              repository,
            );

            await expect(service.createThenFail()).rejects.toThrow(/rollback/);
            expect(await repository.count()).toEqual(0);

            await service.createTwo();
            expect(await repository.count()).toEqual(2);

            await expect(service.requiredInnerFailure()).rejects.toThrow(RollbackOnlyError);
            expect(await repository.count()).toEqual(2);

            await service.requiresNewInnerFailure();
            expect(await repository.count()).toEqual(4);

            const [created] = await repository.findAll();
            await service.renameManagedProduct(created.product_id, "dirty commit");
            const renamed = await repository.findById(created.product_id);
            expect(renamed.product_name).toEqual("dirty commit");
            expect(renamed.version).toEqual(1);
          } finally {
            await runtime.close();
          }
        }),
      240_000,
    );
  }
});

class ProductService {
  readonly transactionManager: unknown;
  readonly repository: ProductRepository;

  constructor(transactionManager: unknown, repository: ProductRepository) {
    this.transactionManager = transactionManager;
    this.repository = repository;
  }

  async createThenFail(): Promise<void> {
    await this.repository.insert(product("rollback one", 10));
    await this.repository.insert(product("rollback two", 20));
    throw new Error("rollback");
  }

  async createTwo(): Promise<void> {
    await this.repository.insert(product("commit one", 30));
    await this.repository.insert(product("commit two", 40));
  }

  async requiredInnerFailure(): Promise<void> {
    await this.repository.insert(product("required outer", 50));

    try {
      await this.innerRequiredFailure();
    } catch {
      await this.repository.insert(product("required recovered", 60));
    }
  }

  async innerRequiredFailure(): Promise<void> {
    await this.repository.insert(product("required inner", 70));
    throw new Error("required inner rollback");
  }

  async requiresNewInnerFailure(): Promise<void> {
    await this.repository.insert(product("requires-new outer", 80));

    try {
      await this.innerRequiresNewFailure();
    } catch {
      await this.repository.insert(product("requires-new recovered", 90));
    }
  }

  async innerRequiresNewFailure(): Promise<void> {
    await this.repository.insert(product("requires-new inner", 100));
    throw new Error("requires-new rollback");
  }

  async renameManagedProduct(id: unknown, name: string): Promise<void> {
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
decorateMethod(ProductService, "requiredInnerFailure", Transaction());
decorateMethod(ProductService, "innerRequiredFailure", Transaction());
decorateMethod(ProductService, "requiresNewInnerFailure", Transaction());
decorateMethod(
  ProductService,
  "innerRequiresNewFailure",
  Transaction({ propagation: NPATransactionPropagation.REQUIRES_NEW }),
);
decorateMethod(ProductService, "renameManagedProduct", Transaction());

function product(name, price, status = "draft") {
  return {
    name,
    price,
    active: true,
    status,
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

function normalizeIsolation(value) {
  return String(value).toLowerCase().replace(/-/g, " ");
}

async function assertTransactionIsolation(
  adapter,
  container,
  tableName,
  runtime,
  repository,
) {
  const probe = transactionIsolationProbe(adapter);
  const writer = await adapter.createQueryable(container);
  const writerRepository = adapter.createRepository({
    entity: createProductEntity(tableName),
    queryable: writer,
  });
  let beforeCount;
  let afterCount;
  let transactionIsolation;

  try {
    await runtime.manager.transactional(
      async () => {
        beforeCount = await repository.countByStatus("isolation-probe");
        if (probe.expectedIsolation) {
          transactionIsolation = await adapter.readTransactionIsolation(
            runtime.queryable,
          );
        }
        await writerRepository.insert(
          product("isolation probe", 5, "isolation-probe"),
        );
        afterCount = await repository.countByStatus("isolation-probe");
      },
      { isolation: probe.isolation },
    );

    expect(beforeCount).toEqual(0);
    expect(afterCount).toEqual(probe.expectedAfterCount);
    if (probe.expectedIsolation) {
      expect(normalizeIsolation(transactionIsolation)).toEqual(probe.expectedIsolation);
    }
  } finally {
    await writerRepository.deleteByStatus("isolation-probe").catch(() => {});
    await adapter.closeQueryable(writer);
  }
}

function transactionIsolationProbe(adapter) {
  if (adapter.adapterName === "postgresql") {
    return {
      isolation: NPATransactionIsolation.REPEATABLE_READ,
      expectedAfterCount: 0,
      expectedIsolation: "repeatable read",
    };
  }

  return {
    isolation: NPATransactionIsolation.READ_COMMITTED,
    expectedAfterCount: 1,
  };
}

function createTeamMemberEntities(
  teamTableName,
  memberTableName,
  roleTableName,
  memberRoleTableName,
) {
  class Team {}
  class Member {}
  class Role {}

  Id({ name: "team_id" })(Team.prototype, "id");
  Column()(Team.prototype, "label");
  OneToMany(() => Member, { mappedBy: "team" })(Team.prototype, "members");
  Entity({ name: teamTableName })(Team);

  Id({ name: "member_id" })(Member.prototype, "id");
  Column()(Member.prototype, "name");
  ManyToOne(() => Team, { joinColumn: "team_id" })(Member.prototype, "team");
  ManyToMany(() => Role, { joinTable: memberRoleTableName })(Member.prototype, "roles");
  Entity({ name: memberTableName })(Member);

  Id({ name: "role_id" })(Role.prototype, "id");
  Column()(Role.prototype, "name");
  Entity({ name: roleTableName })(Role);

  return { Team, Member, Role };
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

function createRoleTableSql(adapter, tableName) {
  const table = adapter.quoteIdentifier(tableName);

  if (adapter.adapterName === "mysql") {
    return `
      CREATE TABLE ${table} (
        role_id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      )
    `;
  }

  return `
    CREATE TABLE ${table} (
      role_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    )
  `;
}

function createMemberRoleTableSql(adapter, tableName) {
  const table = adapter.quoteIdentifier(tableName);

  return `
    CREATE TABLE ${table} (
      member_id INT NOT NULL,
      role_id INT NOT NULL
    )
  `;
}

function insertMemberRoleSql(adapter, tableName, memberId, roleId) {
  const table = adapter.quoteIdentifier(tableName);

  return `
    INSERT INTO ${table} (member_id, role_id)
    VALUES (${Number(memberId)}, ${Number(roleId)})
  `;
}
