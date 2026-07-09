import { CascadeType, Column, CursorPage, Entity, EntityGraph, Id, ManyToOne, ManyToMany, NPARepository, OneToOne, Page, Pageable, Query, RawQueryResult, TransactionIsolation, TransactionPropagation, OneToMany, OptimisticLockError, RollbackOnlyError, Transactional } from "../../src";
import { createPostgresqlDerivedQueryRepository } from "../../packages/pg/src/create-postgresql-derived-query-repository";
import { createMysqlDerivedQueryRepository } from "../../packages/mysql/src/create-mysql-derived-query-repository";
import { assertRepositoryContract, createProductEntity, databaseAdapters, runDatabaseFlow, startContainerOrSkip, uniqueTableName } from "./database-flow";
import { describe, expect, test } from "@jest/globals";

type Row = Record<string, unknown>;
type ProductRepository = NPARepository<Row, unknown> & {
  countByStatus(status: string): Promise<number>;
  deleteByStatus(status: string): Promise<number>;
  findByStatusOrderByCreatedAtDesc(
    status: string,
    pageable: ReturnType<typeof Pageable.cursor>,
  ): Promise<CursorPage<Row>>;
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
  findByNameOrderByTeamLabelAsc(
    name: string,
    pageable: ReturnType<typeof Pageable.cursor>,
  ): Promise<CursorPage<Row>>;
};
type OneToOneRepository = NPARepository<Row, unknown> & {
  existsByProfileBio(bio: string): Promise<boolean>;
  findByProfileBio(bio: string): Promise<Row[]>;
  findByProfileBioOrderByProfileBioAsc(bio: string): Promise<Row[]>;
  findByUserName(name: string): Promise<Row[]>;
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
          }) as ProductRepository;

          await assertRepositoryContract(repository, { nullableStatus: true });
          await assertPaginationContract(repository);
        }),
      240_000,
    );
  }

  for (const adapter of databaseAdapters) {
    test(
      `logs ${adapter.name} repository SQL against a real database`,
      () =>
        runDatabaseFlow(adapter, async ({ queryable, tableName }) => {
          const events = [];
          const slowQueries = [];
          const repository = adapter.createRepository({
            entity: createProductEntity(tableName),
            operations: {
              logger: (event) => events.push(event),
              onSlowQuery: (event) => slowQueries.push(event),
              slowQueryThresholdMs: 0,
            },
            queryable,
          }) as ProductRepository;

          const inserted = await repository.save({
            name: "logging desk",
            price: 120,
            active: true,
            status: "draft",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          });
          await repository.findById(inserted.id);

          expect(events.length).toBeGreaterThanOrEqual(2);
          expect(events).toEqual(slowQueries);
          expect(events[0]).toEqual(expect.objectContaining({
            adapter: adapter.adapterName,
            durationMs: expect.any(Number),
            success: true,
            values: expect.any(Array),
          }));
          expect(events.map((event) => event.text).join("\n")).toMatch(/INSERT/);
          expect(events.map((event) => event.text).join("\n")).toMatch(/SELECT/);
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

          const platform = await teams.save({ label: "platform" });
          const design = await teams.save({ label: "design" });
          const platformId = platform.team_id;
          const designId = design.team_id;

          const kim = await members.save({ name: "kim", team: { id: platformId } });
          const lee = await members.save({ name: "lee", team: { id: designId } });
          const admin = await roles.save({ name: "admin" });
          const writer = await roles.save({ name: "writer" });

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

          await members.save({ name: "pager", team: { id: designId } });
          await members.save({ name: "pager", team: { id: platformId } });

          const firstPage = await members.findByNameOrderByTeamLabelAsc(
            "pager",
            Pageable.cursor({ size: 1 }),
          );
          expect(firstPage.content.map((row) => row.team_id)).toEqual([designId]);
          expect(firstPage.content[0]).not.toHaveProperty("__cursor_0");
          expect(firstPage.nextCursor).not.toEqual(null);

          const secondPage = await members.findByNameOrderByTeamLabelAsc(
            "pager",
            Pageable.cursor({ after: firstPage.nextCursor as string, size: 1 }),
          );
          expect(secondPage.content.map((row) => row.team_id)).toEqual([platformId]);
          expect(secondPage.previousCursor).not.toEqual(null);

          const previousPage = await members.findByNameOrderByTeamLabelAsc(
            "pager",
            Pageable.cursor({ before: secondPage.previousCursor as string, size: 1 }),
          );
          expect(previousPage.content.map((row) => row.team_id)).toEqual([designId]);
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
      `runs ${adapter.name} one-to-one relation E2E against a real database`,
      async () => {
        const userTableName = uniqueTableName(`${adapter.tablePrefix}_one_to_one_users`);
        const profileTableName = uniqueTableName(`${adapter.tablePrefix}_one_to_one_profiles`);
        const container = await startContainerOrSkip(adapter.createContainer());

        if (!container) {
          return;
        }

        let queryable;

        try {
          queryable = await adapter.createQueryable(container);
          await adapter.executeSql(queryable, createOneToOneUserTableSql(adapter, userTableName));
          await adapter.executeSql(
            queryable,
            createOneToOneProfileTableSql(adapter, profileTableName, userTableName),
          );

          const { User, Profile } = createOneToOneEntities(userTableName, profileTableName);
          const users = adapter.createRepository({ entity: User, queryable }) as OneToOneRepository;
          const profiles = adapter.createRepository({ entity: Profile, queryable }) as OneToOneRepository;

          const kim = await users.save({ name: "kim" });
          const lee = await users.save({ name: "lee" });
          const kimProfile = await profiles.save({
            bio: "builder",
            user: { id: kim.id },
          });
          await profiles.save({
            bio: "designer",
            user: { id: lee.id },
          });

          expect((await users.findByProfileBio("builder")).map((row) => row.name)).toEqual(["kim"]);
          expect(await users.existsByProfileBio("designer")).toEqual(true);
          expect((await users.findByProfileBioOrderByProfileBioAsc("builder"))
              .map((row) => row.name)).toEqual(["kim"]);
          expect((await profiles.findByUserName("lee")).map((row) => row.bio)).toEqual(["designer"]);

          const loadedProfile = await profiles.findById(kimProfile.profile_id);
          const loadedProfileUser = await (loadedProfile?.user as Promise<Row>);
          expect(loadedProfileUser.name).toEqual("kim");

          const loadedUser = await users.findById(kim.id);
          const loadedUserProfile = await (loadedUser?.profile as Promise<Row>);
          expect(loadedUserProfile.bio).toEqual("builder");

          const lazyUser = await users.findById(lee.id);
          const lazyProfileFromUser = await (lazyUser?.profile as Promise<Row>);
          expect(lazyProfileFromUser.bio).toEqual("designer");

          const lazyProfile = await profiles.findById(kimProfile.profile_id);
          const lazyUserFromProfile = await (lazyProfile?.user as Promise<Row>);
          expect(lazyUserFromProfile.name).toEqual("kim");
        } finally {
          try {
            if (queryable) {
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(profileTableName)}`,
              );
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(userTableName)}`,
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
      `runs ${adapter.name} composite primary key CRUD E2E against a real database`,
      async () => {
        const tableName = uniqueTableName(`${adapter.tablePrefix}_tenant_users`);
        const container = await startContainerOrSkip(adapter.createContainer());

        if (!container) {
          return;
        }

        let queryable;

        try {
          queryable = await adapter.createQueryable(container);
          await adapter.executeSql(queryable, createCompositeTenantUserTableSql(adapter, tableName));

          const TenantUser = createCompositeTenantUserEntity(tableName);
          const users = adapter.createRepository({ entity: TenantUser, queryable }) as NPARepository<Row, Row>;
          const id = { tenantId: "tenant-a", userId: "user-1" };

          await users.save({ ...id, name: "kim" });

          expect(await users.existsById(id)).toEqual(true);
          expect(await users.findById(id)).toMatchObject({
            tenant_id: "tenant-a",
            user_id: "user-1",
            name: "kim",
          });

          expect(await users.save({ ...id, name: "lee" })).toMatchObject({
            tenant_id: "tenant-a",
            user_id: "user-1",
            name: "lee",
          });
          expect(await users.findById(id)).toMatchObject({ name: "lee" });
          expect(await users.deleteById(id)).toEqual(1);
          expect(await users.existsById(id)).toEqual(false);
        } finally {
          try {
            if (queryable) {
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(tableName)}`,
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
      `runs ${adapter.name} raw @Query methods against a real database`,
      async () => {
        const tableName = uniqueTableName(`${adapter.tablePrefix}_raw_query`);
        const container = await startContainerOrSkip(adapter.createContainer());

        if (!container) {
          return;
        }

        let queryable;

        try {
          queryable = await adapter.createQueryable(container);
          await adapter.executeSql(
            queryable,
            adapter.createTableSql(adapter.quoteIdentifier(tableName)),
          );

          const Product = createProductEntity(tableName);
          const repository = createDecoratedRepository(
            adapter,
            queryable,
            Product,
            createRawProductRepository(adapter, tableName),
          );
          await repository.save(product("raw alpha", 10, "raw"));
          await repository.save(product("raw beta", 20, "raw"));

          expect((await repository.findRawByStatus("raw"))
              .map((row) => row.product_name)
              .sort()).toEqual(["raw alpha", "raw beta"]);
          expect(await repository.countRawByStatus("raw")).toEqual(2);
          expect(await repository.renameRawByStatus("renamed", "raw")).toEqual(2);
          expect((await repository.findRawByStatus("renamed"))
              .map((row) => row.product_name)
              .sort()).toEqual(["renamed", "renamed"]);
        } finally {
          try {
            if (queryable) {
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(tableName)}`,
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
      `runs ${adapter.name} EntityGraph E2E against a real database`,
      async () => {
        const userTableName = uniqueTableName(`${adapter.tablePrefix}_graph_users`);
        const profileTableName = uniqueTableName(`${adapter.tablePrefix}_graph_profiles`);
        const container = await startContainerOrSkip(adapter.createContainer());

        if (!container) {
          return;
        }

        let queryable;

        try {
          queryable = await adapter.createQueryable(container);
          await adapter.executeSql(queryable, createOneToOneUserTableSql(adapter, userTableName));
          await adapter.executeSql(
            queryable,
            createOneToOneProfileTableSql(adapter, profileTableName, userTableName),
          );

          const { User, Profile } = createOneToOneEntities(userTableName, profileTableName);
          const users = createDecoratedRepository(
            adapter,
            queryable,
            User,
            createGraphUserRepository(),
          );
          const profiles = adapter.createRepository({ entity: Profile, queryable });
          const user = await users.save({ name: "graph kim" });
          await profiles.save({ bio: "loaded", user: { id: user.id } });

          const loaded = await users.findById(user.id);
          expect(loaded.name).toEqual("graph kim");
          expect((loaded.profile as Row).bio).toEqual("loaded");
        } finally {
          try {
            if (queryable) {
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(profileTableName)}`,
              );
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(userTableName)}`,
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
      `detects ${adapter.name} optimistic lock conflicts against a real database`,
      () =>
        runDatabaseFlow(adapter, async ({ queryable, tableName }) => {
          const Product = createProductEntity(tableName);
          const firstRepository = adapter.createRepository({
            entity: Product,
            queryable,
          }) as ProductRepository;
          const secondRepository = adapter.createRepository({
            entity: Product,
            queryable,
          }) as ProductRepository;
          const created = await firstRepository.save(product("locked", 10));
          const firstCopy = await firstRepository.findById(created.id);
          const secondCopy = await secondRepository.findById(created.id);

          firstCopy.name = "first";
          secondCopy.name = "second";

          await firstRepository.save(firstCopy);
          await expect(secondRepository.save(secondCopy)).rejects.toThrow(
            OptimisticLockError,
          );
        }),
      240_000,
    );
  }

  for (const adapter of databaseAdapters) {
    test(
      `runs ${adapter.name} @Transactional E2E against a real database`,
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
            const createdId = entityId(created, "product_id");
            await service.renameManagedProduct(createdId, "dirty commit");
            const renamed = await repository.findById(createdId);
            expect(renamed.product_name).toEqual("dirty commit");
            expect(renamed.version).toEqual(1);
          } finally {
            await runtime.close();
          }
        }),
      240_000,
    );
  }

  for (const adapter of databaseAdapters) {
    test(
      `runs ${adapter.name} cascade and orphanRemoval E2E against a real database`,
      async () => {
        const teamTableName = uniqueTableName(`${adapter.tablePrefix}_cascade_teams`);
        const memberTableName = uniqueTableName(`${adapter.tablePrefix}_cascade_members`);
        const roleTableName = uniqueTableName(`${adapter.tablePrefix}_cascade_roles`);
        const memberRoleTableName = uniqueTableName(`${adapter.tablePrefix}_cascade_member_roles`);
        const container = await startContainerOrSkip(adapter.createContainer());

        if (!container) {
          return;
        }

        const runtime = await adapter.createTransactionRuntime(container);
        const queryable = runtime.queryable;

        try {
          await adapter.executeSql(queryable, createTeamTableSql(adapter, teamTableName));
          await adapter.executeSql(
            queryable,
            createMemberTableSql(adapter, memberTableName, teamTableName),
          );
          await adapter.executeSql(queryable, createRoleTableSql(adapter, roleTableName));
          await adapter.executeSql(
            queryable,
            createMemberRoleTableSql(
              adapter,
              memberRoleTableName,
              memberTableName,
              roleTableName,
            ),
          );

          const { Team, Member, Role } = createCascadeTeamMemberEntities(
            teamTableName,
            memberTableName,
            roleTableName,
            memberRoleTableName,
          );
          const teams = adapter.createRepository({ entity: Team, queryable }) as NPARepository<Row, unknown>;
          const members = adapter.createRepository({ entity: Member, queryable }) as NPARepository<Row, unknown>;
          const roles = adapter.createRepository({ entity: Role, queryable }) as NPARepository<Row, unknown>;
          const team = {
            label: "platform",
            members: [
              { name: "kim", roles: [{ name: "admin" }] },
              { name: "lee", roles: [{ name: "writer" }] },
            ],
          } as Row;

          await teams.save(team);

          const teamId = entityId(team, "team_id");
          expect(await teams.count()).toEqual(1);
          expect(await members.count()).toEqual(2);
          expect(await roles.count()).toEqual(2);
          expect(await tableCount(adapter, queryable, memberRoleTableName)).toEqual(2);

          await runtime.manager.transactional(async () => {
            const managedTeam = await teams.findById(teamId);

            if (!managedTeam) {
              throw new Error("Managed team was not found.");
            }

            const loadedMembers = await (managedTeam.members as Promise<Row[]>);
            managedTeam.members = loadedMembers
              .filter((member) => member.name !== "lee");
          });

          expect(await members.count()).toEqual(1);
          expect(await roles.count()).toEqual(1);
          expect(await tableCount(adapter, queryable, memberRoleTableName)).toEqual(1);

          expect(await teams.deleteById(teamId)).toEqual(1);
          expect(await teams.count()).toEqual(0);
          expect(await members.count()).toEqual(0);
          expect(await roles.count()).toEqual(0);
          expect(await tableCount(adapter, queryable, memberRoleTableName)).toEqual(0);
        } finally {
          try {
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
          } finally {
            await runtime.close();
            await container.stop();
          }
        }
      },
      240_000,
    );
  }
});

function createDecoratedRepository(adapter, queryable, entity, target) {
  if (adapter.adapterName === "postgresql") {
    return createPostgresqlDerivedQueryRepository(target, { entity, queryable });
  }

  return createMysqlDerivedQueryRepository(target, { entity, queryable });
}

function createRawProductRepository(adapter, tableName) {
  class RawProductRepository {}

  const table = adapter.quoteIdentifier(tableName);
  const nameColumn = adapter.quoteIdentifier("product_name");
  const statusColumn = adapter.quoteIdentifier("status");

  Query(
    `SELECT * FROM ${table} WHERE ${statusColumn} = :status`,
  )(RawProductRepository.prototype, "findRawByStatus");
  Query(
    `SELECT COUNT(*) FROM ${table} WHERE ${statusColumn} = :status`,
    { result: RawQueryResult.SCALAR },
  )(RawProductRepository.prototype, "countRawByStatus");
  Query(
    `UPDATE ${table} SET ${nameColumn} = :name WHERE ${statusColumn} = :status`,
    { result: RawQueryResult.EXECUTE },
  )(RawProductRepository.prototype, "renameRawByStatus");

  return new RawProductRepository();
}

function createGraphUserRepository() {
  class GraphUserRepository {}

  EntityGraph("profile")(GraphUserRepository.prototype, "findById");

  return new GraphUserRepository();
}

class ProductService {
  readonly transactionManager: unknown;
  readonly repository: ProductRepository;

  constructor(transactionManager: unknown, repository: ProductRepository) {
    this.transactionManager = transactionManager;
    this.repository = repository;
  }

  async createThenFail(): Promise<void> {
    await this.repository.save(product("rollback one", 10));
    await this.repository.save(product("rollback two", 20));
    throw new Error("rollback");
  }

  async createTwo(): Promise<void> {
    await this.repository.save(product("commit one", 30));
    await this.repository.save(product("commit two", 40));
  }

  async requiredInnerFailure(): Promise<void> {
    await this.repository.save(product("required outer", 50));

    try {
      await this.innerRequiredFailure();
    } catch {
      await this.repository.save(product("required recovered", 60));
    }
  }

  async innerRequiredFailure(): Promise<void> {
    await this.repository.save(product("required inner", 70));
    throw new Error("required inner rollback");
  }

  async requiresNewInnerFailure(): Promise<void> {
    await this.repository.save(product("requires-new outer", 80));

    try {
      await this.innerRequiresNewFailure();
    } catch {
      await this.repository.save(product("requires-new recovered", 90));
    }
  }

  async innerRequiresNewFailure(): Promise<void> {
    await this.repository.save(product("requires-new inner", 100));
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

decorateMethod(ProductService, "createThenFail", Transactional());
decorateMethod(
  ProductService,
  "createTwo",
  Transactional({ isolation: TransactionIsolation.READ_COMMITTED }),
);
decorateMethod(ProductService, "requiredInnerFailure", Transactional());
decorateMethod(ProductService, "innerRequiredFailure", Transactional());
decorateMethod(ProductService, "requiresNewInnerFailure", Transactional());
decorateMethod(
  ProductService,
  "innerRequiresNewFailure",
  Transactional({ propagation: TransactionPropagation.REQUIRES_NEW }),
);
decorateMethod(ProductService, "renameManagedProduct", Transactional());

async function assertPaginationContract(repository: ProductRepository) {
  await repository.save(product(
    "page alpha",
    10,
    "active",
    new Date("2026-01-01T00:00:00.000Z"),
  ));
  await repository.save(product(
    "page beta",
    20,
    "active",
    new Date("2026-01-03T00:00:00.000Z"),
  ));
  await repository.save(product(
    "page gamma",
    30,
    "active",
    new Date("2026-01-03T00:00:00.000Z"),
  ));
  await repository.save(product(
    "page delta",
    40,
    "active",
    new Date("2026-01-02T00:00:00.000Z"),
  ));

  const offsetPage = await repository.findAll({
    pageable: Pageable.offset(1, 2),
  }) as Page<Row>;
  expect(offsetPage.content.map((row) => row.product_name)).toEqual([
    "page gamma",
    "page delta",
  ]);
  expect(offsetPage.totalElements).toEqual(4);
  expect(offsetPage.totalPages).toEqual(2);
  expect(offsetPage.hasPreviousPage).toEqual(true);
  expect(offsetPage.hasNextPage).toEqual(false);

  const firstPage = await repository.findByStatusOrderByCreatedAtDesc(
    "active",
    Pageable.cursor({ size: 2 }),
  );
  expect(firstPage.content.map((row) => row.product_name)).toEqual([
    "page beta",
    "page gamma",
  ]);
  expect(firstPage.hasNextPage).toEqual(true);
  expect(firstPage.hasPreviousPage).toEqual(false);
  expect(firstPage.nextCursor).not.toEqual(null);

  const secondPage = await repository.findByStatusOrderByCreatedAtDesc(
    "active",
    Pageable.cursor({ after: firstPage.nextCursor as string, size: 2 }),
  );
  expect(secondPage.content.map((row) => row.product_name)).toEqual([
    "page delta",
    "page alpha",
  ]);
  expect(secondPage.hasNextPage).toEqual(false);
  expect(secondPage.hasPreviousPage).toEqual(true);
  expect(secondPage.previousCursor).not.toEqual(null);

  const previousPage = await repository.findByStatusOrderByCreatedAtDesc(
    "active",
    Pageable.cursor({ before: secondPage.previousCursor as string, size: 2 }),
  );
  expect(previousPage.content.map((row) => row.product_name)).toEqual([
    "page beta",
    "page gamma",
  ]);

  await repository.deleteAll();
  expect(await repository.count()).toEqual(0);
}

function product(
  name,
  price,
  status = "draft",
  createdAt = new Date("2026-01-01T00:00:00.000Z"),
) {
  return {
    name,
    price,
    active: true,
    status,
    createdAt,
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
        await insertIsolationProbe(adapter, writer, tableName);
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
    await deleteIsolationProbe(adapter, writer, tableName).catch(() => {});
    await adapter.closeQueryable(writer);
  }
}

async function insertIsolationProbe(adapter, writer, tableName) {
  const table = adapter.quoteIdentifier(tableName);
  await adapter.executeSql(
    writer,
    [
      `INSERT INTO ${table}`,
      "(product_name, price, active, status, created_at, version)",
      "VALUES ('isolation probe', 5, TRUE, 'isolation-probe', CURRENT_TIMESTAMP, 0)",
    ].join(" "),
  );
}

async function deleteIsolationProbe(adapter, writer, tableName) {
  await adapter.executeSql(
    writer,
    `DELETE FROM ${adapter.quoteIdentifier(tableName)} WHERE status = 'isolation-probe'`,
  );
}

function transactionIsolationProbe(adapter) {
  if (adapter.adapterName === "postgresql") {
    return {
      isolation: TransactionIsolation.REPEATABLE_READ,
      expectedAfterCount: 0,
      expectedIsolation: "repeatable read",
    };
  }

  return {
    isolation: TransactionIsolation.READ_COMMITTED,
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

function createMemberTableSql(adapter, tableName, teamTableName?) {
  const table = adapter.quoteIdentifier(tableName);
  const team = teamTableName ? adapter.quoteIdentifier(teamTableName) : null;
  const foreignKey = team
    ? `,\n        FOREIGN KEY (team_id) REFERENCES ${team} (team_id)`
    : "";

  if (adapter.adapterName === "mysql") {
    return `
      CREATE TABLE ${table} (
        member_id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        team_id INT NULL
        ${foreignKey}
      )
    `;
  }

  return `
    CREATE TABLE ${table} (
      member_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      team_id INTEGER NULL
      ${foreignKey}
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

function createMemberRoleTableSql(adapter, tableName, memberTableName?, roleTableName?) {
  const table = adapter.quoteIdentifier(tableName);
  const member = memberTableName ? adapter.quoteIdentifier(memberTableName) : null;
  const role = roleTableName ? adapter.quoteIdentifier(roleTableName) : null;
  const constraints = member && role
    ? `,
      PRIMARY KEY (member_id, role_id),
      FOREIGN KEY (member_id) REFERENCES ${member} (member_id),
      FOREIGN KEY (role_id) REFERENCES ${role} (role_id)`
    : "";

  return `
    CREATE TABLE ${table} (
      member_id INT NOT NULL,
      role_id INT NOT NULL
      ${constraints}
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

function createOneToOneUserTableSql(adapter, tableName) {
  const table = adapter.quoteIdentifier(tableName);

  if (adapter.adapterName === "mysql") {
    return `
      CREATE TABLE ${table} (
        user_id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      )
    `;
  }

  return `
    CREATE TABLE ${table} (
      user_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    )
  `;
}

function createOneToOneProfileTableSql(adapter, tableName, userTableName) {
  const table = adapter.quoteIdentifier(tableName);
  const userTable = adapter.quoteIdentifier(userTableName);

  if (adapter.adapterName === "mysql") {
    return `
      CREATE TABLE ${table} (
        profile_id INT AUTO_INCREMENT PRIMARY KEY,
        bio VARCHAR(255) NOT NULL,
        user_id INT NOT NULL UNIQUE,
        FOREIGN KEY (user_id) REFERENCES ${userTable} (user_id)
      )
    `;
  }

  return `
    CREATE TABLE ${table} (
      profile_id SERIAL PRIMARY KEY,
      bio TEXT NOT NULL,
      user_id INTEGER NOT NULL UNIQUE,
      FOREIGN KEY (user_id) REFERENCES ${userTable} (user_id)
    )
  `;
}

function createOneToOneEntities(userTableName, profileTableName) {
  class User {}
  class Profile {}

  Id({ name: "user_id" })(User.prototype, "id");
  Column()(User.prototype, "name");
  OneToOne(() => Profile, { mappedBy: "user" })(User.prototype, "profile");
  Entity({ name: userTableName })(User);

  Id({ name: "profile_id" })(Profile.prototype, "id");
  Column()(Profile.prototype, "bio");
  OneToOne(() => User, { joinColumn: "user_id" })(Profile.prototype, "user");
  Entity({ name: profileTableName })(Profile);

  return { User, Profile };
}

function createCompositeTenantUserTableSql(adapter, tableName) {
  const table = adapter.quoteIdentifier(tableName);

  if (adapter.adapterName === "mysql") {
    return `
      CREATE TABLE ${table} (
        tenant_id VARCHAR(64) NOT NULL,
        user_id VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        PRIMARY KEY (tenant_id, user_id)
      )
    `;
  }

  return `
    CREATE TABLE ${table} (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (tenant_id, user_id)
    )
  `;
}

function createCompositeTenantUserEntity(tableName) {
  class TenantUser {}

  Id({ name: "tenant_id" })(TenantUser.prototype, "tenantId");
  Id({ name: "user_id" })(TenantUser.prototype, "userId");
  Column()(TenantUser.prototype, "name");
  Entity({ name: tableName })(TenantUser);

  return TenantUser;
}

function createCascadeTeamMemberEntities(
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
  OneToMany(() => Member, {
    mappedBy: "team",
    cascade: [CascadeType.PERSIST],
    orphanRemoval: true,
  })(Team.prototype, "members");
  Entity({ name: teamTableName })(Team);

  Id({ name: "member_id" })(Member.prototype, "id");
  Column()(Member.prototype, "name");
  ManyToOne(() => Team, { joinColumn: "team_id" })(Member.prototype, "team");
  ManyToMany(() => Role, {
    joinTable: memberRoleTableName,
    cascade: [CascadeType.PERSIST, CascadeType.REMOVE],
  })(Member.prototype, "roles");
  Entity({ name: memberTableName })(Member);

  Id({ name: "role_id" })(Role.prototype, "id");
  Column()(Role.prototype, "name");
  ManyToMany(() => Member, { mappedBy: "roles" })(Role.prototype, "members");
  Entity({ name: roleTableName })(Role);

  return { Team, Member, Role };
}

async function tableCount(adapter, queryable, tableName) {
  const result = await adapter.executeSql(
    queryable,
    `SELECT COUNT(*) AS count FROM ${adapter.quoteIdentifier(tableName)}`,
  );
  const rows = Array.isArray(result) ? result[0] : result.rows;

  return Number(rows[0].count);
}

function entityId(entity, columnName) {
  return entity.id ?? entity[columnName];
}
