import {
  compilePostgresqlDeleteById,
  compilePostgresqlDeleteAll,
  compilePostgresqlExistsById,
  compilePostgresqlFindAll,
  compilePostgresqlFindById,
  compilePostgresqlInsert,
  compilePostgresqlCount,
  compilePostgresqlUpdate,
  compilePostgresqlVersionedUpdate,
  getPrimaryKeyValue,
} from "../src/postgresql-crud-compiler";
import { compilePostgresqlQuery } from "../src/postgresql-query-compiler";
import { compilePostgresqlRawQuery } from "../src/postgresql-raw-query";
import { createPostgresqlDerivedQueryRepository } from "../src/create-postgresql-derived-query-repository";
import { PostgresqlConnection, type PostgresqlDriverConnection } from "../src/postgresql-connection";
import { postgresql } from "../src/postgresql-adapter";
import type { PostgresqlQueryable } from "../src/types";
import {
  Column,
  CreatedAt,
  CursorPage,
  Entity,
  EntityGraph,
  EnumType,
  FetchType,
  Id,
  Loaded,
  ManyToMany,
  ManyToOne,
  NPADatabaseError,
  NPARepository,
  OptimisticLockError,
  OneToOne,
  OneToMany,
  Pageable,
  Query,
  Repository,
  UpdatedAt,
  Version,
  createNPA,
  defineEntityGraph,
  parseQueryMethod,
} from "../../../src";
import { AbstractTransactionManager } from "../../../src/transaction/transaction-manager";
import { describe, expect, test } from "@jest/globals";

type DynamicRepository = Record<string, (...args: unknown[]) => unknown>;

function asPgQueryable(queryable: unknown): PostgresqlQueryable {
  return queryable as PostgresqlQueryable;
}

@Entity({ name: "products" })
class PgProduct {
  @Id({ name: "product_id" })
  id!: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;

  @Version({ name: "lock_version" })
  version!: number;
}

@Entity({ name: "products" })
class PgPlainProduct {
  @Id({ name: "product_id" })
  id!: number;

  @Column({ name: "product_name" })
  name!: string;
}

@Entity({ name: "generated_products" })
class PgGeneratedProduct {
  @Id({ name: "product_id", generationStrategy: "AUTO_INCREMENT" })
  id!: number;

  @Column({ name: "product_name" })
  name!: string;
}

@Entity({ name: "ordinal_tasks" })
class PgOrdinalTask {
  @Id()
  id!: number;

  @Column({ enum: ["LOW", "HIGH"], enumType: EnumType.ORDINAL })
  priority!: string;
}

@Entity({ name: "array_tasks" })
class PgArrayTask {
  @Id()
  id!: number;

  @Column({ array: true })
  tags!: string[];
}

@Entity({ name: "tenant_users" })
class PgTenantUser {
  @Id({ name: "tenant_id" })
  tenantId!: string;

  @Id({ name: "user_id" })
  userId!: string;

  @Column()
  name!: string;
}

@Entity({ name: "tenant_teams" })
class PgTenantTeam {
  @Id({ name: "tenant_id" })
  tenantId!: string;

  @Id({ name: "team_id" })
  teamId!: string;

  @Column()
  label!: string;
}

@Entity({ name: "tenant_members" })
class PgTenantMember {
  @Id({ name: "member_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => PgTenantTeam)
  team!: PgTenantTeam;
}

@Entity({ name: "products" })
class PgTimestampedProduct {
  @Id({ name: "product_id" })
  id!: number;

  @Column({ name: "product_name" })
  name!: string;

  @CreatedAt({ name: "created_at" })
  createdAt!: Date;

  @UpdatedAt({ name: "updated_at" })
  updatedAt!: Date;
}

abstract class PgProductRepository extends NPARepository<PgProduct, number> {
  repositoryName(): string {
    return "pg-products";
  }
}

Repository(PgProduct)(PgProductRepository);

@Entity({ name: "organizations" })
class PgOrganization {
  @Id({ name: "organization_id" })
  id!: number;

  @Column()
  name!: string;
}

@Entity({ name: "app_users" })
class PgAppUser {
  @Id({ name: "user_id" })
  id!: number;

  @Column()
  name!: string;

  @OneToOne(() => PgAppUserProfile, { mappedBy: "user" })
  profile!: unknown;
}

@Entity({ name: "app_user_profiles" })
class PgAppUserProfile {
  @Id({ name: "profile_id" })
  id!: number;

  @Column()
  bio!: string;

  @OneToOne(() => PgAppUser, { joinColumn: "user_id" })
  user!: unknown;
}

@Entity({ name: "teams" })
class PgTeam {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  label!: string;

  @ManyToOne(() => PgOrganization, { joinColumn: "organization_id" })
  organization!: PgOrganization;

  @OneToMany(() => PgMember, { mappedBy: "team" })
  members!: PgMember[];
}

@Entity({ name: "roles" })
class PgRole {
  @Id({ name: "role_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToMany(() => PgMember, { mappedBy: "roles" })
  members!: PgMember[];
}

@Entity({ name: "members" })
class PgMember {
  @Id({ name: "member_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => PgTeam, { joinColumn: "team_id" })
  team!: PgTeam;

  @ManyToMany(() => PgRole, { joinTable: "member_roles" })
  roles!: PgRole[];
}

@Entity({ name: "pg_eager_teams" })
class PgEagerTeam {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  label!: string;

  @OneToMany(() => PgEagerMember, { mappedBy: "team", fetch: FetchType.EAGER })
  members!: PgEagerMember[];
}

@Entity({ name: "pg_eager_members" })
class PgEagerMember {
  @Id({ name: "member_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => PgEagerTeam, { joinColumn: "team_id", fetch: FetchType.EAGER })
  team!: PgEagerTeam;
}

const memberGraph = defineEntityGraph<PgMember>({
  team: {
    organization: true,
  },
  roles: true,
});

abstract class PgMemberGraphRepository extends NPARepository<PgMember, number> {
  @EntityGraph(memberGraph)
  abstract findByName: (
    name: string,
  ) => Promise<Loaded<PgMember, typeof memberGraph>[]>;
}

abstract class PgMemberByIdGraphRepository extends NPARepository<PgMember, number> {
  @EntityGraph(memberGraph)
  abstract findById: (id: number) => Promise<Loaded<PgMember, typeof memberGraph> | null>;
}

abstract class PgTeamMembersGraphRepository extends NPARepository<PgTeam, number> {}

EntityGraph(["members"])(PgTeamMembersGraphRepository.prototype, "findAll");

@Entity({ name: "broken_teams" })
class PgBrokenTeam {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  label!: string;

  @OneToMany(() => PgBrokenMember)
  members!: PgBrokenMember[];
}

@Entity({ name: "broken_members" })
class PgBrokenMember {
  @Id({ name: "member_id" })
  id!: number;

  @Column()
  name!: string;
}

class TestTransactionManager extends AbstractTransactionManager<object> {
  protected acquireTransactionResource() {
    return {};
  }

  protected beginTransaction() {}

  protected commitTransaction() {}

  protected rollbackTransaction() {}
}
describe("PostgreSQL adapter", () => {
  test("maps constraint driver errors to database error codes", async () => {
    const cases = [
      { driver: { code: "23505" }, code: "NPA_DATABASE_UNIQUE_CONSTRAINT_FAILED" },
      { driver: { code: "23503" }, code: "NPA_DATABASE_FOREIGN_KEY_CONSTRAINT_FAILED" },
      { driver: { code: "23502" }, code: "NPA_DATABASE_NOT_NULL_CONSTRAINT_FAILED" },
    ];

    for (const testCase of cases) {
      const connection = new PostgresqlConnection({
        query() {
          throw Object.assign(new Error("driver failed"), testCase.driver);
        },
      });

      await expect(connection.query("SELECT 1")).rejects.toBeInstanceOf(NPADatabaseError);
      await expect(connection.query("SELECT 1")).rejects.toMatchObject({
        code: testCase.code,
      });
    }
  });

  test("compiles a derived query method into parameterized PostgreSQL SQL", () => {
    expect(
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
    ).toEqual({
      text: 'SELECT * FROM "users" WHERE ("name" LIKE $1 AND "age" > $2) ORDER BY "created_at" DESC LIMIT 2',
      values: ["%kim%", 20],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod(
            "findDistinctTop2ByNameContainingIgnoreCaseAndEmailAllIgnoreCaseOrderByNameAscAgeDesc",
          ),
          args: ["KIM", "A@EXAMPLE.COM"],
        },
        { tableName: "users" },
      ),
    ).toEqual({
      text: 'SELECT DISTINCT * FROM "users" WHERE (LOWER("name") LIKE $1 AND LOWER("email") = $2) ORDER BY "name" ASC, "age" DESC LIMIT 2',
      values: ["%kim%", "a@example.com"],
    });
    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByPriority"),
          args: ["HIGH"],
        },
        { entity: PgOrdinalTask },
      ),
    ).toEqual({
      text: 'SELECT * FROM "ordinal_tasks" WHERE ("priority" = $1)',
      values: [1],
    });
  });

  test("compiles PostgreSQL offset and cursor pagination SQL", () => {
    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByStatus"),
          args: ["active"],
          pageable: Pageable.offset(1, 2),
        },
        { entity: PgProduct },
      ),
    ).toEqual({
      text: 'SELECT * FROM "products" WHERE ("status" = $1) ORDER BY "product_id" ASC LIMIT 2 OFFSET 2',
      values: ["active"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByStatusOrderByCreatedAtDesc"),
          args: ["active"],
          pageable: Pageable.cursor({
            after: cursorToken(["2026-01-01T00:00:00.000Z", 10]),
            size: 2,
          }),
        },
        { entity: PgProduct },
      ),
    ).toEqual({
      text: 'SELECT * FROM "products" WHERE ("status" = $1) AND (("created_at" < $2) OR ("created_at" = $3 AND "product_id" > $4)) ORDER BY "created_at" DESC, "product_id" ASC LIMIT 3',
      values: [
        "active",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        10,
      ],
      cursor: expect.any(Object),
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByStatusOrderByCreatedAtDesc"),
          args: ["active"],
          pageable: Pageable.cursor({
            before: cursorToken(["2026-01-01T00:00:00.000Z", 10]),
            size: 2,
          }),
        },
        { entity: PgProduct },
      ),
    ).toEqual({
      text: 'SELECT * FROM "products" WHERE ("status" = $1) AND (("created_at" > $2) OR ("created_at" = $3 AND "product_id" < $4)) ORDER BY "created_at" ASC, "product_id" DESC LIMIT 3',
      values: [
        "active",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        10,
      ],
      cursor: expect.any(Object),
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
      text: 'SELECT * FROM "users" WHERE ("name" = $1) OR ("age" > $2 AND "active" IS TRUE)',
      values: ["kim", 20],
    });
  });

  test("compiles PostgreSQL null and empty-list derived query parameters", () => {
    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByName"),
          args: [null],
        },
        { tableName: "users" },
      ),
    ).toEqual({
      text: 'SELECT * FROM "users" WHERE ("name" IS NULL)',
      values: [],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByNameNot"),
          args: [null],
        },
        { tableName: "users" },
      ),
    ).toEqual({
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
      ),
    ).toThrow(/expects a non-empty array parameter/);

    expect(() =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByStatusNotIn"),
          args: [[]],
        },
        { tableName: "users" },
      ),
    ).toThrow(/expects a non-empty array parameter/);

    expect(() =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByName"),
          args: [undefined],
        },
        { tableName: "users" },
      ),
    ).toThrow(/must not be undefined/);
  });

  test("compiles PostgreSQL derived queries across relation fields", () => {
    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeam"),
          args: [{ id: 7, label: "platform" }],
        },
        { entity: PgMember },
      ),
    ).toEqual({
      text: 'SELECT * FROM "members" WHERE ("team_id" = $1)',
      values: [7],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeamIn"),
          args: [
            [
              { id: 7, label: "platform" },
              { id: 8, label: "infra" },
            ],
          ],
        },
        { entity: PgMember },
      ),
    ).toEqual({
      text: 'SELECT * FROM "members" WHERE ("team_id" = ANY($1))',
      values: [[7, 8]],
    });

    expect(() =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeam"),
          args: [{ label: "platform" }],
        },
        { entity: PgMember },
      ),
    ).toThrow(/Relation team requires PgTeam.id or team_id/);

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeamLabelAndNameOrderByTeamLabelDesc"),
          args: ["platform", "kim"],
        },
        { entity: PgMember },
      ),
    ).toEqual({
      text: 'SELECT "t0".* FROM "members" AS "t0" JOIN "teams" AS "t1" ON "t0"."team_id" = "t1"."team_id" WHERE ("t1"."label" = $1 AND "t0"."name" = $2) ORDER BY "t1"."label" DESC',
      values: ["platform", "kim"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod(
            "findByTeamOrganizationNameOrderByTeamOrganizationNameDesc",
          ),
          args: ["openai"],
        },
        { entity: PgMember },
      ),
    ).toEqual({
      text: 'SELECT "t0".* FROM "members" AS "t0" JOIN "teams" AS "t1" ON "t0"."team_id" = "t1"."team_id" JOIN "organizations" AS "t2" ON "t1"."organization_id" = "t2"."organization_id" WHERE ("t2"."name" = $1) ORDER BY "t2"."name" DESC',
      values: ["openai"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByProfileBioOrderByProfileBioAsc"),
          args: ["hello"],
        },
        { entity: PgAppUser },
      ),
    ).toEqual({
      text: 'SELECT "t0".* FROM "app_users" AS "t0" JOIN "app_user_profiles" AS "t1" ON "t1"."user_id" = "t0"."user_id" WHERE ("t1"."bio" = $1) ORDER BY "t1"."bio" ASC',
      values: ["hello"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByUserNameOrderByUserNameAsc"),
          args: ["kim"],
        },
        { entity: PgAppUserProfile },
      ),
    ).toEqual({
      text: 'SELECT "t0".* FROM "app_user_profiles" AS "t0" JOIN "app_users" AS "t1" ON "t0"."user_id" = "t1"."user_id" WHERE ("t1"."name" = $1) ORDER BY "t1"."name" ASC',
      values: ["kim"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByNameOrderByTeamLabelAsc"),
          args: ["kim"],
          pageable: Pageable.cursor({ size: 2 }),
        },
        { entity: PgMember },
      ),
    ).toEqual({
      text: 'SELECT "t0".*, "t1"."label" AS "__cursor_0" FROM "members" AS "t0" JOIN "teams" AS "t1" ON "t0"."team_id" = "t1"."team_id" WHERE ("t0"."name" = $1) ORDER BY "t1"."label" ASC, "t0"."member_id" ASC LIMIT 3',
      values: ["kim"],
      cursor: expect.any(Object),
    });

    expect(() =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByNameOrderByRolesNameAsc"),
          args: ["kim"],
          pageable: Pageable.cursor({ size: 2 }),
        },
        { entity: PgMember },
      ),
    ).toThrow(/Cursor pagination only supports scalar or @ManyToOne OrderBy properties/);

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("countByMembersName"),
          args: ["kim"],
        },
        { entity: PgTeam },
      ),
    ).toEqual({
      text: 'SELECT COUNT(*)::int AS "count" FROM "teams" AS "t0" JOIN "members" AS "t1" ON "t1"."team_id" = "t0"."team_id" WHERE ("t1"."name" = $1)',
      values: ["kim"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("countByMembersRolesName"),
          args: ["admin"],
        },
        { entity: PgTeam },
      ),
    ).toEqual({
      text: 'SELECT COUNT(*)::int AS "count" FROM "teams" AS "t0" JOIN "members" AS "t1" ON "t1"."team_id" = "t0"."team_id" JOIN "member_roles" AS "t3" ON "t3"."pg_member_member_id" = "t1"."member_id" JOIN "roles" AS "t2" ON "t2"."role_id" = "t3"."pg_role_role_id" WHERE ("t2"."name" = $1)',
      values: ["admin"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("countDistinctByTeamLabelIgnoreCase"),
          args: ["PLATFORM"],
        },
        { entity: PgMember },
      ),
    ).toEqual({
      text: 'SELECT COUNT(DISTINCT "t0"."member_id")::int AS "count" FROM "members" AS "t0" JOIN "teams" AS "t1" ON "t0"."team_id" = "t1"."team_id" WHERE (LOWER("t1"."label") = $1)',
      values: ["platform"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByRolesName"),
          args: ["admin"],
        },
        { entity: PgMember },
      ),
    ).toEqual({
      text: 'SELECT "t0".* FROM "members" AS "t0" JOIN "member_roles" AS "t2" ON "t2"."pg_member_member_id" = "t0"."member_id" JOIN "roles" AS "t1" ON "t1"."role_id" = "t2"."pg_role_role_id" WHERE ("t1"."name" = $1)',
      values: ["admin"],
    });

    expect(() =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByRolesMissing"),
          args: ["admin"],
        },
        { entity: PgMember },
      ),
    ).toThrow(
      /Relation query PgMember\.rolesMissing targets PgRole\.missing, but that property is not a column/,
    );

    expect(() =>
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByMembersName"),
          args: ["kim"],
        },
        { entity: PgBrokenTeam },
      ),
    ).toThrow(/@OneToMany PgBrokenTeam\.members requires mappedBy/);

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("deleteByTeamLabel"),
          args: ["platform"],
        },
        { entity: PgMember },
      ),
    ).toEqual({
      text: 'DELETE FROM "members" AS "t0" USING "teams" AS "t1" WHERE "t0"."team_id" = "t1"."team_id" AND ("t1"."label" = $1)',
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
    expect(
      await repository.existsByActiveFalseAndNameStartingWith("kim"),
    ).toEqual(true);
    expect(await repository.countByAgeBetween(20, 40)).toEqual(2);
    expect(await repository.deleteByStatusIn(["inactive", "blocked"])).toEqual(
      2,
    );

    expect(calls).toEqual([
      {
        text: 'SELECT * FROM "users" WHERE ("name" = $1) LIMIT 1',
        values: ["kim alpha"],
      },
      {
        text: 'SELECT EXISTS(SELECT 1 FROM "users" WHERE ("active" IS FALSE AND "name" LIKE $1)) AS "exists"',
        values: ["kim%"],
      },
      {
        text: 'SELECT COUNT(*)::int AS "count" FROM "users" WHERE ("age" BETWEEN $1 AND $2)',
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
      adapter: postgresql({ connection: asPgQueryable(queryable) }),
      repositories: [PgProductRepository],
    });
    const products = npa.get(PgProductRepository) as PgProductRepository &
      DynamicRepository;

    expect(products instanceof PgProductRepository).toEqual(true);
    expect(products.repositoryName()).toEqual("pg-products");
    const product = await products.findById(10);
    expect(product).toEqual({
      product_id: 10,
      product_name: "desk",
    });
    expect(product?.id).toEqual(10);
    expect(product?.name).toEqual("desk");

    const namedProducts = await products.findByName("desk");
    expect(namedProducts).toEqual([
      { product_id: "desk", product_name: "desk" },
    ]);
    expect(namedProducts[0]?.id).toEqual("desk");
    expect(namedProducts[0]?.name).toEqual("desk");

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

  test("logs PostgreSQL SQL through NPA operations", async () => {
    const events = [];
    const slowQueries = [];
    const queryable = {
      async query(_text, values) {
        return {
          rows: [{ product_id: values[0], product_name: "desk" }],
          rowCount: 1,
        };
      },
    };
    const npa = createNPA({
      adapter: postgresql({
        connection: new PostgresqlConnection(asPgQueryable(queryable)),
      }),
      operations: {
        logger: (event) => {
          events.push(event);
        },
        onSlowQuery: (event) => {
          slowQueries.push(event);
        },
        slowQueryThresholdMs: 0,
      },
      repositories: [PgProductRepository],
    });
    const products = npa.get(PgProductRepository) as PgProductRepository &
      DynamicRepository;

    await products.findById(10);

    expect(events).toEqual([
      expect.objectContaining({
        adapter: "postgresql",
        text: 'SELECT * FROM "products" WHERE "product_id" = $1 LIMIT 1',
        values: [10],
        success: true,
        rowCount: 1,
        durationMs: expect.any(Number),
      }),
    ]);
    expect(slowQueries).toEqual(events);
  });

  test("wraps PostgreSQL driver errors and logs SQL context", async () => {
    const events = [];
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "products_pkey",
      detail: "Key already exists.",
    });
    const queryable = {
      async query() {
        throw driverError;
      },
    };
    const npa = createNPA({
      adapter: postgresql({
        connection: new PostgresqlConnection(asPgQueryable(queryable)),
      }),
      operations: {
        logger: (event) => {
          events.push(event);
        },
      },
      repositories: [PgProductRepository],
    });
    const products = npa.get(PgProductRepository) as PgProductRepository &
      DynamicRepository;

    await expect(products.findById(10)).rejects.toMatchObject({
      code: "NPA_DATABASE_UNIQUE_CONSTRAINT_FAILED",
      details: {
        adapter: "postgresql",
        constraint: "products_pkey",
        detail: "Key already exists.",
        driverCode: "23505",
        text: 'SELECT * FROM "products" WHERE "product_id" = $1 LIMIT 1',
        values: [10],
      },
      name: "NPADatabaseError",
    });

    const error = await products.findById(10).catch((caught) => caught);
    expect(error).toBeInstanceOf(NPADatabaseError);
    expect(error.cause).toBe(driverError);
    expect(events[0]).toEqual(expect.objectContaining({
      adapter: "postgresql",
      error: expect.any(NPADatabaseError),
      success: false,
      text: 'SELECT * FROM "products" WHERE "product_id" = $1 LIMIT 1',
      values: [10],
    }));
  });

  test("creates a transaction manager when PostgreSQL adapter receives a connection", async () => {
    const calls = [];
    const adapter = postgresql({
      connection: asPgQueryable({
        query(text, values) {
          calls.push({ text, values });

          return {
            rows: text.startsWith("SELECT")
              ? [{ product_id: values?.[0], product_name: "desk" }]
              : [],
            rowCount: 1,
          };
        },
      }),
    });
    const products = adapter.createRepository({
      entity: PgProduct,
      repository: PgProductRepository,
    }) as PgProductRepository & DynamicRepository;

    expect(adapter.transactionManager).toBeDefined();
    await expect(
      adapter.transactionManager?.transactional(() => products.findById(10)),
    ).resolves.toEqual({
      product_id: 10,
      product_name: "desk",
    });
    expect(calls).toEqual([
      { text: "BEGIN", values: undefined },
      {
        text: 'SELECT * FROM "products" WHERE "product_id" = $1 LIMIT 1',
        values: [10],
      },
      { text: "COMMIT", values: undefined },
    ]);
  });

  test("compiles insert, update, and deleteById PostgreSQL CRUD SQL", () => {
    const options = {
      tableName: "users",
      columns: {
        createdAt: "created_at",
      },
    };

    expect(
      compilePostgresqlInsert(
        { id: undefined, name: "kim", age: 20, createdAt: 3 },
        options,
      ),
    ).toEqual({
      text: 'INSERT INTO "users" ("name", "age", "created_at") VALUES ($1, $2, $3) RETURNING *',
      values: ["kim", 20, 3],
    });
    expect(
      compilePostgresqlInsert(
        { id: 0, name: "desk" },
        { entity: PgGeneratedProduct },
      ),
    ).toEqual({
      text: 'INSERT INTO "generated_products" ("product_name") VALUES ($1) RETURNING *',
      values: ["desk"],
    });
    expect(
      compilePostgresqlInsert(
        { id: 1, priority: "HIGH" },
        { entity: PgOrdinalTask },
      ),
    ).toEqual({
      text: 'INSERT INTO "ordinal_tasks" ("id", "priority") VALUES ($1, $2) RETURNING *',
      values: [1, 1],
    });
    expect(
      compilePostgresqlInsert(
        { id: 1, tags: ["new", "sale"] },
        { entity: PgArrayTask },
      ),
    ).toEqual({
      text: 'INSERT INTO "array_tasks" ("id", "tags") VALUES ($1, $2) RETURNING *',
      values: [1, ["new", "sale"]],
    });
    expect(
      getPrimaryKeyValue(
        { id: 0, name: "desk" },
        { entity: PgGeneratedProduct },
      ),
    ).toBeUndefined();
    expect(
      compilePostgresqlUpdate(1, { id: 1, name: "lee", createdAt: 4 }, options),
    ).toEqual({
      text: 'UPDATE "users" SET "name" = $1, "created_at" = $2 WHERE "id" = $3 RETURNING *',
      values: ["lee", 4, 1],
    });
    expect(
      compilePostgresqlUpdate(
        1,
        { priority: "LOW" },
        { entity: PgOrdinalTask },
      ),
    ).toEqual({
      text: 'UPDATE "ordinal_tasks" SET "priority" = $1 WHERE "id" = $2 RETURNING *',
      values: [0, 1],
    });
    expect(
      compilePostgresqlUpdate(
        1,
        { tags: ["clearance"] },
        { entity: PgArrayTask },
      ),
    ).toEqual({
      text: 'UPDATE "array_tasks" SET "tags" = $1 WHERE "id" = $2 RETURNING *',
      values: [["clearance"], 1],
    });
    expect(() =>
        compilePostgresqlInsert(
          { id: 1, tags: "new" as unknown as string[] },
          { entity: PgArrayTask },
        )).toThrow(/requires an array value/);
    expect(() => compilePostgresqlUpdate(1, { id: 1 }, options)).toThrow(
      /without changed values/,
    );
    expect(() =>
      compilePostgresqlVersionedUpdate(1, { id: 1, version: 2 }, 2, {
        entity: PgProduct,
      }),
    ).toThrow(/without changed values/);
    expect(
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
    ).toEqual({
      text: 'UPDATE "audit"."user""events" SET "display""name" = $1 WHERE "id" = $2 RETURNING *',
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
      text: 'SELECT EXISTS(SELECT 1 FROM "users" WHERE "id" = $1) AS "exists"',
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

  test("compiles PostgreSQL composite primary key CRUD SQL", () => {
    const options = { entity: PgTenantUser };
    const id = { tenantId: "t1", userId: "u1" };

    expect(compilePostgresqlFindById(id, options)).toEqual({
      text: 'SELECT * FROM "tenant_users" WHERE "tenant_id" = $1 AND "user_id" = $2 LIMIT 1',
      values: ["t1", "u1"],
    });
    expect(compilePostgresqlUpdate(id, { name: "kim" }, options)).toEqual({
      text: 'UPDATE "tenant_users" SET "name" = $1 WHERE "tenant_id" = $2 AND "user_id" = $3 RETURNING *',
      values: ["kim", "t1", "u1"],
    });
    expect(compilePostgresqlDeleteById(id, options)).toEqual({
      text: 'DELETE FROM "tenant_users" WHERE "tenant_id" = $1 AND "user_id" = $2',
      values: ["t1", "u1"],
    });
    expect(() => compilePostgresqlFindById("t1", options)).toThrow(
      expect.objectContaining({
        code: "NPA_COMPOSITE_ID_OBJECT_REQUIRED",
        name: "NPAPersistenceError",
      }),
    );
  });

  test("compiles PostgreSQL composite relation key SQL", () => {
    expect(
      compilePostgresqlInsert(
        {
          name: "kim",
          team: { tenantId: "t1", teamId: "team1" },
        },
        { entity: PgTenantMember },
      ),
    ).toEqual({
      text:
        'INSERT INTO "tenant_members" ("name", "team_tenant_id", "team_team_id") VALUES ($1, $2, $3) RETURNING *',
      values: ["kim", "t1", "team1"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeam"),
          args: [{ tenantId: "t1", teamId: "team1" }],
        },
        { entity: PgTenantMember },
      ),
    ).toEqual({
      text:
        'SELECT * FROM "tenant_members" WHERE ("team_tenant_id" = $1 AND "team_team_id" = $2)',
      values: ["t1", "team1"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeamIn"),
          args: [[
            { tenantId: "t1", teamId: "team1" },
            { tenantId: "t1", teamId: "team2" },
          ]],
        },
        { entity: PgTenantMember },
      ),
    ).toEqual({
      text:
        'SELECT * FROM "tenant_members" WHERE (("team_tenant_id", "team_team_id") IN (($1, $2), ($3, $4)))',
      values: ["t1", "team1", "t1", "team2"],
    });

    expect(
      compilePostgresqlQuery(
        {
          query: parseQueryMethod("findByTeamLabel"),
          args: ["platform"],
        },
        { entity: PgTenantMember },
      ),
    ).toEqual({
      text:
        'SELECT "t0".* FROM "tenant_members" AS "t0" JOIN "tenant_teams" AS "t1" ON "t0"."team_tenant_id" = "t1"."tenant_id" AND "t0"."team_team_id" = "t1"."team_id" WHERE ("t1"."label" = $1)',
      values: ["platform"],
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

    abstract class RawProductRepository extends NPARepository<
      PgProduct,
      number
    > {}

    Query('SELECT * FROM "products" WHERE "price" > :minPrice', {
      result: "many",
    })(RawProductRepository.prototype, "findExpensiveProducts");
    Query('SELECT * FROM "products" WHERE "product_id" = :id', {
      result: "one",
    })(RawProductRepository.prototype, "findOneProductRaw");
    Query(
      'SELECT COUNT(*) AS total FROM "products" WHERE "price" > :minPrice',
      { result: "scalar" },
    )(RawProductRepository.prototype, "countProductsRaw");
    Query(
      'UPDATE "products" SET "price" = "price" + :amount WHERE "price" < :amount',
      { result: "execute" },
    )(RawProductRepository.prototype, "raisePricesRaw");

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

    abstract class RawProductRepository extends NPARepository<
      PgProduct,
      number
    > {}

    Query('SELECT * FROM "products"', { result: "many" })(
      RawProductRepository.prototype,
      "findProductsRaw",
    );
    Query('SELECT * FROM "products" WHERE "product_id" = :id', {
      result: "one",
    })(RawProductRepository.prototype, "findOneProductRaw");
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
    expect(
      compilePostgresqlRawQuery(
        'SELECT :id::int AS id, \':id\' AS literal WHERE "owner_id" = :id AND "status" = :status',
        [7, "active"],
        "findRaw",
      ),
    ).toEqual({
      text: 'SELECT $1::int AS id, \':id\' AS literal WHERE "owner_id" = $1 AND "status" = $2',
      values: [7, "active"],
    });

    expect(
      compilePostgresqlRawQuery(
        "SELECT ? AS value, '?' AS literal",
        [1],
        "findRaw",
      ),
    ).toEqual({
      text: "SELECT $1 AS value, '?' AS literal",
      values: [1],
    });

    expect(() =>
      compilePostgresqlRawQuery("SELECT :id, :status", [7], "findRaw"),
    ).toThrow(/uses named parameter/);
  });

  test("runs repository save and delete operations through a PostgreSQL queryable", async () => {
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

    expect(await repository.save({ name: "kim", createdAt: 3 })).toEqual({
      id: 3,
      name: "kim",
      created_at: 3,
    });
    expect(await repository.save({ name: "park" })).toEqual({
      id: "park",
      name: "park",
      created_at: 3,
    });
    expect(await repository.save({ id: 1, name: "lee" })).toEqual({
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
        text: 'INSERT INTO "users" ("name", "created_at") VALUES ($1, $2) RETURNING *',
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
        text: 'SELECT EXISTS(SELECT 1 FROM "users" WHERE "id" = $1) AS "exists"',
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

  test("runs save and delete through a PostgreSQL persistence context", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("INSERT")) {
          return {
            rows: [{ product_id: 7, product_name: values[0] }],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 1 };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgPlainProduct, queryable: asPgQueryable(queryable) },
    ) as NPARepository<PgPlainProduct, number>;
    const product = { name: "desk" } as PgPlainProduct;

    expect(await repository.save(product)).toBe(product);
    expect(product.id).toEqual(7);
    await repository.delete(product);

    expect(calls).toEqual([
      {
        text: 'INSERT INTO "products" ("product_name") VALUES ($1) RETURNING *',
        values: ["desk"],
      },
      {
        text: 'DELETE FROM "products" WHERE "product_id" = $1',
        values: [7],
      },
    ]);
  });

  test("treats falsy PostgreSQL generated ids as unset on save", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        return {
          rows: [{ product_id: 8, product_name: values[0] }],
          rowCount: 1,
        };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgGeneratedProduct, queryable: asPgQueryable(queryable) },
    ) as NPARepository<PgGeneratedProduct, number>;

    await expect(repository.save({ id: 0, name: "desk" })).resolves.toEqual({
      id: 8,
      name: "desk",
    });

    expect(calls).toEqual([
      {
        text: 'INSERT INTO "generated_products" ("product_name") VALUES ($1) RETURNING *',
        values: ["desk"],
      },
    ]);
  });

  test("syncs PostgreSQL many-to-many join rows during save and delete", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith('INSERT INTO "members"')) {
          return {
            rows: [{ member_id: 1, name: values[0] }],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 1 };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgMember, queryable: asPgQueryable(queryable) },
    ) as NPARepository<PgMember, number>;
    const member = {
      name: "kim",
      roles: [{ id: 5, name: "admin" } as PgRole],
    } as PgMember;

    await repository.save(member);
    await repository.delete(member);

    expect(calls).toEqual([
      {
        text: 'INSERT INTO "members" ("name") VALUES ($1) RETURNING *',
        values: ["kim"],
      },
      {
        text:
          'DELETE FROM "member_roles" WHERE "pg_member_member_id" = $1',
        values: [1],
      },
      {
        text:
          'INSERT INTO "member_roles" ("pg_member_member_id", "pg_role_role_id") VALUES ($1, $2) ON CONFLICT DO NOTHING',
        values: [1, 5],
      },
      {
        text:
          'DELETE FROM "member_roles" WHERE "pg_member_member_id" = $1',
        values: [1],
      },
      {
        text: 'DELETE FROM "members" WHERE "member_id" = $1',
        values: [1],
      },
    ]);
  });

  test("syncs inverse PostgreSQL many-to-many join rows", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith('INSERT INTO "roles"')) {
          return {
            rows: [{ role_id: 5, name: values[0] }],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 1 };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgRole, queryable: asPgQueryable(queryable) },
    ) as NPARepository<PgRole, number>;
    const role = {
      name: "admin",
      members: [{ id: 1, name: "kim" } as PgMember],
    } as PgRole;

    await repository.save(role);

    expect(calls).toEqual([
      {
        text: 'INSERT INTO "roles" ("name") VALUES ($1) RETURNING *',
        values: ["admin"],
      },
      {
        text:
          'DELETE FROM "member_roles" WHERE "pg_role_role_id" = $1',
        values: [5],
      },
      {
        text:
          'INSERT INTO "member_roles" ("pg_role_role_id", "pg_member_member_id") VALUES ($1, $2) ON CONFLICT DO NOTHING',
        values: [5, 1],
      },
    ]);
  });

  test("runs PostgreSQL direct and derived deletes through ORM cleanup when relations need it", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("SELECT")) {
          return {
            rows: [{ member_id: values[0] === "kim" ? 2 : values[0], name: "kim" }],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 1 };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgMember, queryable: asPgQueryable(queryable) },
    ) as NPARepository<PgMember, number> & {
      deleteByName(name: string): Promise<number>;
    };

    expect(await repository.deleteById(1)).toEqual(1);
    expect(await repository.deleteByName("kim")).toEqual(1);

    expect(calls).toEqual([
      {
        text: 'SELECT * FROM "members" WHERE "member_id" = $1 LIMIT 1',
        values: [1],
      },
      {
        text:
          'DELETE FROM "member_roles" WHERE "pg_member_member_id" = $1',
        values: [1],
      },
      {
        text: 'DELETE FROM "members" WHERE "member_id" = $1',
        values: [1],
      },
      {
        text: 'SELECT DISTINCT * FROM "members" WHERE ("name" = $1)',
        values: ["kim"],
      },
      {
        text:
          'DELETE FROM "member_roles" WHERE "pg_member_member_id" = $1',
        values: [2],
      },
      {
        text: 'DELETE FROM "members" WHERE "member_id" = $1',
        values: [2],
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
          rows: [
            {
              product_id: 1,
              product_name: values[0],
              updated_at: values[1],
            },
          ],
          rowCount: 1,
        };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgTimestampedProduct, queryable: asPgQueryable(queryable) },
    ) as NPARepository<Record<string, unknown>, number>;

    await repository.save({ name: "desk" });
    await repository.save({ id: 1, name: "chair" });

    expect(calls).toEqual([
      {
        text: 'INSERT INTO "products" ("product_name") VALUES ($1) RETURNING *',
        values: ["desk"],
      },
      {
        text: 'UPDATE "products" SET "product_name" = $1, "updated_at" = $2 WHERE "product_id" = $3 RETURNING *',
        values: ["chair", expect.any(Date), 1],
      },
    ]);
  });

  test("uses optimistic PostgreSQL update SQL only for versioned saves", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        return {
          rows: [
            {
              product_id: values.at(-2) ?? values.at(-1),
              product_name: values[0],
              lock_version: 1,
            },
          ],
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

    await versioned.save({ id: 1, name: "chair", version: 0 });
    await plain.save({ id: 2, name: "desk" });

    expect(calls).toEqual([
      {
        text: 'UPDATE "products" SET "product_name" = $1, "lock_version" = "lock_version" + 1 WHERE "product_id" = $2 AND "lock_version" = $3 RETURNING *',
        values: ["chair", 1, 0],
      },
      {
        text: 'UPDATE "products" SET "product_name" = $1 WHERE "product_id" = $2 RETURNING *',
        values: ["desk", 2],
      },
    ]);
  });

  test("throws on stale PostgreSQL versioned saves without inserting", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });
        return text.startsWith("SELECT EXISTS")
          ? { rows: [{ exists: true }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgProduct, queryable: asPgQueryable(queryable) },
    );

    await expect(
      repository.save({ id: 1, name: "stale", version: 0 }),
    ).rejects.toThrow(OptimisticLockError);
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toMatch(/^UPDATE /);
    expect(calls[1].text).toMatch(/^SELECT EXISTS/);
  });

  test("loads PostgreSQL many-to-one, one-to-many, and many-to-many relations", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text === 'SELECT * FROM "members" WHERE "member_id" = $1 LIMIT 1') {
          return {
            rows: [{ member_id: values[0], name: "kim", team_id: 2 }],
            rowCount: 1,
          };
        }

        if (text === 'SELECT * FROM "teams" WHERE "team_id" IN ($1)') {
          return {
            rows: [{ team_id: 2, label: "core", organization_id: 3 }],
            rowCount: 1,
          };
        }

        if (
          text ===
          'SELECT * FROM "organizations" WHERE "organization_id" IN ($1)'
        ) {
          return {
            rows: [{ organization_id: 3, name: "platform" }],
            rowCount: 1,
          };
        }

        if (text.includes('FROM "member_roles" j')) {
          return {
            rows: [
              { __source_id: 10, role_id: 7, name: "admin" },
              { __source_id: 10, role_id: 8, name: "writer" },
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
    const loadedMembers = createPostgresqlDerivedQueryRepository(
      Object.create(PgMemberByIdGraphRepository.prototype),
      { entity: PgMember, queryable: asPgQueryable(queryable) },
    );
    const teams = createPostgresqlDerivedQueryRepository(
      Object.create(PgTeamMembersGraphRepository.prototype),
      { entity: PgTeam, queryable: asPgQueryable(queryable) },
    );

    const lazyMember = await members.findById(10);
    expect(await lazyMember.team).toEqual({
      organization_id: 3,
      team_id: 2,
      label: "core",
    });
    expect(await lazyMember.roles).toEqual([
      { role_id: 7, name: "admin" },
      { role_id: 8, name: "writer" },
    ]);

    const member = await loadedMembers.findById(10);
    expect(member?.team).toEqual({
      organization: { organization_id: 3, name: "platform" },
      organization_id: 3,
      team_id: 2,
      label: "core",
    });
    expect(member?.roles).toEqual([
      { role_id: 7, name: "admin" },
      { role_id: 8, name: "writer" },
    ]);

    const [team] = await teams.findAll();
    expect(team.members).toEqual([
      { member_id: 10, name: "kim", team_id: 2 },
      { member_id: 11, name: "lee", team_id: 2 },
    ]);

    expect(calls.length).toEqual(9);
  });

  test("loads PostgreSQL @EntityGraph relations only for decorated repository methods", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text === 'SELECT * FROM "members" WHERE ("name" = $1)') {
          return {
            rows: [{ member_id: 10, name: values[0], team_id: 2 }],
            rowCount: 1,
          };
        }

        if (
          text ===
          'SELECT * FROM "members" WHERE ("name" = $1) ORDER BY "member_id" ASC LIMIT 2'
        ) {
          return {
            rows: [{ member_id: 10, name: values[0], team_id: 2 }],
            rowCount: 1,
          };
        }

        if (text === 'SELECT * FROM "teams" WHERE "team_id" IN ($1)') {
          return {
            rows: [{ team_id: 2, label: "core", organization_id: 3 }],
            rowCount: 1,
          };
        }

        if (
          text ===
          'SELECT * FROM "organizations" WHERE "organization_id" IN ($1)'
        ) {
          return {
            rows: [{ organization_id: 3, name: "platform" }],
            rowCount: 1,
          };
        }

        if (text.includes('FROM "member_roles" j')) {
          return {
            rows: [
              { __source_id: 10, role_id: 7, name: "admin" },
              { __source_id: 10, role_id: 8, name: "writer" },
            ],
            rowCount: 2,
          };
        }

        throw new Error(`Unexpected query: ${text}`);
      },
    };
    const repository = createPostgresqlDerivedQueryRepository(
      Object.create(PgMemberGraphRepository.prototype),
      { entity: PgMember, queryable: asPgQueryable(queryable) },
    );

    const [member] = await repository.findByName("kim");
    expect(member.team).toEqual({
      organization: { organization_id: 3, name: "platform" },
      organization_id: 3,
      team_id: 2,
      label: "core",
    });
    expect(member.roles).toEqual([
      { role_id: 7, name: "admin" },
      { role_id: 8, name: "writer" },
    ]);
    expect(calls.length).toEqual(4);

    calls.length = 0;
    const page = await (repository as DynamicRepository).findByName(
      "kim",
      Pageable.cursor({ size: 1 }),
    ) as CursorPage<PgMember>;
    expect(page.content[0].team).toEqual({
      organization: { organization_id: 3, name: "platform" },
      organization_id: 3,
      team_id: 2,
      label: "core",
    });
    expect(page.content[0].roles).toEqual([
      { role_id: 7, name: "admin" },
      { role_id: 8, name: "writer" },
    ]);
    expect(page.hasNextPage).toEqual(false);
    expect(calls.length).toEqual(4);
  });

  test("loads PostgreSQL eager relations without @EntityGraph", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text === 'SELECT * FROM "pg_eager_members" WHERE "member_id" = $1 LIMIT 1') {
          return { rows: [{ member_id: values[0], name: "kim", team_id: 2 }] };
        }

        if (text === 'SELECT * FROM "pg_eager_teams" WHERE "team_id" IN ($1)') {
          return { rows: [{ team_id: 2, label: "core" }] };
        }

        if (text === 'SELECT * FROM "pg_eager_members" WHERE "team_id" IN ($1)') {
          return {
            rows: [
              { member_id: 10, name: "kim", team_id: 2 },
              { member_id: 11, name: "lee", team_id: 2 },
            ],
          };
        }

        throw new Error(`Unexpected query: ${text}`);
      },
    };
    const members = createPostgresqlDerivedQueryRepository(
      {},
      { entity: PgEagerMember, queryable: queryable as PostgresqlQueryable },
    );

    const member = await members.findById(10);

    expect(member.team).toEqual({
      members: [
        { member_id: 10, name: "kim", team_id: 2 },
        { member_id: 11, name: "lee", team_id: 2 },
      ],
      team_id: 2,
      label: "core",
    });
    expect(calls).toHaveLength(3);
  });

  test("flushes dirty managed entities through a PostgreSQL repository", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("UPDATE")) {
          return {
            rows: [
              {
                product_id: 1,
                product_name: values[0],
                price: values[1],
                lock_version: 1,
              },
            ],
            rowCount: 1,
          };
        }

        return {
          rows: [
            { product_id: 1, product_name: "desk", price: 10, lock_version: 0 },
          ],
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
        text: 'SELECT * FROM "products" WHERE "product_id" = $1 LIMIT 1',
        values: [1],
      },
      {
        text: 'UPDATE "products" SET "product_name" = $1, "price" = $2, "lock_version" = "lock_version" + 1 WHERE "product_id" = $3 AND "lock_version" = $4 RETURNING *',
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

function cursorToken(values: unknown[]): string {
  return Buffer.from(JSON.stringify({ v: 1, values }), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
