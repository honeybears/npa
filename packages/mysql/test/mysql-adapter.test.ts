import { AbstractTransactionManager, Column, CreatedAt, Entity, EntityGraph, EnumType, FetchType, Id, Loaded, ManyToMany, ManyToOne, NPADatabaseError, NPARepository, OneToOne, OneToMany, Pageable, Query, Repository, UpdatedAt, Version, createNPA, defineEntityGraph, parseQueryMethod } from "../../../src";
import { compileMysqlCount, compileMysqlDeleteAll, compileMysqlDeleteById, compileMysqlExistsById, compileMysqlFindAll, compileMysqlInsert, compileMysqlQuery, compileMysqlRawQuery, compileMysqlUpdate, compileMysqlVersionedUpdate, compileMysqlFindById, createMysqlDerivedQueryRepository, getMysqlPrimaryKeyValue, MysqlConnection, mysql, type MysqlDriverConnection, type MysqlQueryable } from "../src";
import { describe, expect, test } from "@jest/globals";

type DynamicRepository = Record<string, (...args: unknown[]) => unknown>;

function asMysqlQueryable(queryable: unknown): MysqlQueryable {
  return queryable as MysqlQueryable;
}

@Entity({ name: "products", schema: "shop" })
class Product {
  @Id({ name: "product_id" })
  id!: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;

  @Column()
  active!: boolean;

  @Column()
  status!: string;

  @Column({ name: "created_at" })
  createdAt!: number;
}

@Entity({ name: "generated_products", schema: "shop" })
class GeneratedProduct {
  @Id({ name: "product_id", generationStrategy: "AUTO_INCREMENT" })
  id!: number;

  @Column({ name: "product_name" })
  name!: string;
}

@Entity({ name: "ordinal_tasks" })
class OrdinalTask {
  @Id()
  id!: number;

  @Column({ enum: ["LOW", "HIGH"], enumType: EnumType.ORDINAL })
  priority!: string;
}

@Entity({ name: "array_tasks" })
class ArrayTask {
  @Id()
  id!: number;

  @Column({ array: true })
  tags!: string[];
}

abstract class ProductRepository extends NPARepository<Product, number> {
  repositoryName(): string {
    return "mysql-products";
  }
}

Repository(Product)(ProductRepository);

@Entity({ name: "tenant_users" })
class TenantUser {
  @Id({ name: "tenant_id" })
  tenantId!: string;

  @Id({ name: "user_id" })
  userId!: string;

  @Column()
  name!: string;
}

@Entity({ name: "tenant_teams" })
class TenantTeam {
  @Id({ name: "tenant_id" })
  tenantId!: string;

  @Id({ name: "team_id" })
  teamId!: string;

  @Column()
  label!: string;
}

@Entity({ name: "tenant_members" })
class TenantMember {
  @Id({ name: "member_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => TenantTeam)
  team!: TenantTeam;
}

@Entity({ name: "organizations" })
class Organization {
  @Id({ name: "organization_id" })
  id!: number;

  @Column()
  name!: string;
}

@Entity({ name: "app_users" })
class AppUser {
  @Id({ name: "user_id" })
  id!: number;

  @Column()
  name!: string;

  @OneToOne(() => AppUserProfile, { mappedBy: "user" })
  profile!: unknown;
}

@Entity({ name: "app_user_profiles" })
class AppUserProfile {
  @Id({ name: "profile_id" })
  id!: number;

  @Column()
  bio!: string;

  @OneToOne(() => AppUser, { joinColumn: "user_id" })
  user!: unknown;
}

@Entity({ name: "teams" })
class Team {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  label!: string;

  @ManyToOne(() => Organization, { joinColumn: "organization_id" })
  organization!: Organization;

  @OneToMany(() => Member, { mappedBy: "team" })
  members!: Member[];
}

@Entity({ name: "roles" })
class Role {
  @Id({ name: "role_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToMany(() => Member, { mappedBy: "roles" })
  members!: Member[];
}

@Entity({ name: "members" })
class Member {
  @Id({ name: "member_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => Team, { joinColumn: "team_id" })
  team!: Team;

  @ManyToMany(() => Role, { joinTable: "member_roles" })
  roles!: Role[];
}

@Entity({ name: "eager_teams" })
class EagerTeam {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  label!: string;

  @OneToMany(() => EagerMember, { mappedBy: "team", fetch: FetchType.EAGER })
  members!: EagerMember[];
}

@Entity({ name: "eager_members" })
class EagerMember {
  @Id({ name: "member_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => EagerTeam, { joinColumn: "team_id", fetch: FetchType.EAGER })
  team!: EagerTeam;
}

const memberGraph = defineEntityGraph<Member>({
  team: {
    organization: true,
  },
  roles: true,
});

abstract class MemberGraphRepository extends NPARepository<Member, number> {
  @EntityGraph(memberGraph)
  abstract findByName: (name: string) => Promise<Loaded<Member, typeof memberGraph>[]>;
}

abstract class MemberByIdGraphRepository extends NPARepository<Member, number> {
  @EntityGraph(memberGraph)
  abstract findById: (id: number) => Promise<Loaded<Member, typeof memberGraph> | null>;
}

abstract class TeamMembersGraphRepository extends NPARepository<Team, number> {
  @EntityGraph(["members"])
  abstract findAll: () => Promise<Array<Loaded<Team, ["members"]>>>;
}

@Entity({ name: "broken_teams" })
class BrokenTeam {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  label!: string;

  @OneToMany(() => BrokenMember)
  members!: BrokenMember[];
}

@Entity({ name: "broken_members" })
class BrokenMember {
  @Id({ name: "member_id" })
  id!: number;

  @Column()
  name!: string;
}

@Entity({ name: "products", schema: "shop" })
class VersionedProduct {
  @Id({ name: "product_id" })
  id!: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;

  @Version({ name: "lock_version" })
  version!: number;
}

@Entity({ name: "products", schema: "shop" })
class TimestampedProduct {
  @Id({ name: "product_id" })
  id!: number;

  @Column({ name: "product_name" })
  name!: string;

  @CreatedAt({ name: "created_at" })
  createdAt!: Date;

  @UpdatedAt({ name: "updated_at" })
  updatedAt!: Date;
}

class TestTransactionManager extends AbstractTransactionManager<object> {
  protected acquireTransactionResource() {
    return {};
  }

  protected beginTransaction() {}

  protected commitTransaction() {}

  protected rollbackTransaction() {}
}
describe("MySQL adapter", () => {
  test("maps constraint driver errors to database error codes", async () => {
    const cases = [
      { driver: { code: "ER_DUP_ENTRY", errno: 1062 }, code: "NPA_DATABASE_UNIQUE_CONSTRAINT_FAILED" },
      { driver: { code: "ER_NO_REFERENCED_ROW_2", errno: 1452 }, code: "NPA_DATABASE_FOREIGN_KEY_CONSTRAINT_FAILED" },
      { driver: { code: "ER_BAD_NULL_ERROR", errno: 1048 }, code: "NPA_DATABASE_NOT_NULL_CONSTRAINT_FAILED" },
    ];

    for (const testCase of cases) {
      const connection = new MysqlConnection({
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
    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByPriority"),
          args: ["HIGH"],
        },
        { entity: OrdinalTask },
      )).toEqual({
        text: "SELECT * FROM `ordinal_tasks` WHERE (`priority` = ?)",
        values: [1],
      });
  });

  test("compiles MySQL offset and cursor pagination SQL", () => {
    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByStatus"),
          args: ["active"],
          pageable: Pageable.offset(1, 2),
        },
        { entity: Product },
      )).toEqual({
        text:
          "SELECT * FROM `shop`.`products` WHERE (`status` = ?) ORDER BY `product_id` ASC LIMIT 2 OFFSET 2",
        values: ["active"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByStatusOrderByCreatedAtDesc"),
          args: ["active"],
          pageable: Pageable.cursor({
            after: cursorToken(["2026-01-01T00:00:00.000Z", 10]),
            size: 2,
          }),
        },
        { entity: Product },
      )).toEqual({
        text:
          "SELECT * FROM `shop`.`products` WHERE (`status` = ?) AND ((`created_at` < ?) OR (`created_at` = ? AND `product_id` > ?)) ORDER BY `created_at` DESC, `product_id` ASC LIMIT 3",
        values: [
          "active",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          10,
        ],
        cursor: expect.any(Object),
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByStatusOrderByCreatedAtDesc"),
          args: ["active"],
          pageable: Pageable.cursor({
            before: cursorToken(["2026-01-01T00:00:00.000Z", 10]),
            size: 2,
          }),
        },
        { entity: Product },
      )).toEqual({
        text:
          "SELECT * FROM `shop`.`products` WHERE (`status` = ?) AND ((`created_at` > ?) OR (`created_at` = ? AND `product_id` < ?)) ORDER BY `created_at` ASC, `product_id` DESC LIMIT 3",
        values: [
          "active",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          10,
        ],
        cursor: expect.any(Object),
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
          "SELECT `t0`.* FROM `members` AS `t0` JOIN `teams` AS `t1` ON `t0`.`team_id` = `t1`.`team_id` WHERE (`t1`.`label` = ? AND `t0`.`name` = ?) ORDER BY `t1`.`label` DESC",
        values: ["platform", "kim"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByTeamOrganizationNameOrderByTeamOrganizationNameDesc"),
          args: ["openai"],
        },
        { entity: Member },
      )).toEqual({
        text:
          "SELECT `t0`.* FROM `members` AS `t0` JOIN `teams` AS `t1` ON `t0`.`team_id` = `t1`.`team_id` JOIN `organizations` AS `t2` ON `t1`.`organization_id` = `t2`.`organization_id` WHERE (`t2`.`name` = ?) ORDER BY `t2`.`name` DESC",
        values: ["openai"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByProfileBioOrderByProfileBioAsc"),
          args: ["hello"],
        },
        { entity: AppUser },
      )).toEqual({
        text:
          "SELECT `t0`.* FROM `app_users` AS `t0` JOIN `app_user_profiles` AS `t1` ON `t1`.`user_id` = `t0`.`user_id` WHERE (`t1`.`bio` = ?) ORDER BY `t1`.`bio` ASC",
        values: ["hello"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByUserNameOrderByUserNameAsc"),
          args: ["kim"],
        },
        { entity: AppUserProfile },
      )).toEqual({
        text:
          "SELECT `t0`.* FROM `app_user_profiles` AS `t0` JOIN `app_users` AS `t1` ON `t0`.`user_id` = `t1`.`user_id` WHERE (`t1`.`name` = ?) ORDER BY `t1`.`name` ASC",
        values: ["kim"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("findByNameOrderByTeamLabelAsc"),
          args: ["kim"],
          pageable: Pageable.cursor({ size: 2 }),
        },
        { entity: Member },
      )).toEqual({
        text:
          "SELECT `t0`.*, `t1`.`label` AS `__cursor_0` FROM `members` AS `t0` JOIN `teams` AS `t1` ON `t0`.`team_id` = `t1`.`team_id` WHERE (`t0`.`name` = ?) ORDER BY `t1`.`label` ASC, `t0`.`member_id` ASC LIMIT 3",
        values: ["kim"],
        cursor: expect.any(Object),
      });

    expect(() =>
        compileMysqlQuery(
          {
            query: parseQueryMethod("findByNameOrderByRolesNameAsc"),
            args: ["kim"],
            pageable: Pageable.cursor({ size: 2 }),
          },
          { entity: Member },
        )).toThrow(/Cursor pagination only supports scalar or @ManyToOne OrderBy properties/);

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("countByMembersName"),
          args: ["kim"],
        },
        { entity: Team },
      )).toEqual({
        text:
          "SELECT COUNT(*) AS `count` FROM `teams` AS `t0` JOIN `members` AS `t1` ON `t1`.`team_id` = `t0`.`team_id` WHERE (`t1`.`name` = ?)",
        values: ["kim"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("countByMembersRolesName"),
          args: ["admin"],
        },
        { entity: Team },
      )).toEqual({
        text:
          "SELECT COUNT(*) AS `count` FROM `teams` AS `t0` JOIN `members` AS `t1` ON `t1`.`team_id` = `t0`.`team_id` JOIN `member_roles` AS `t3` ON `t3`.`member_id` = `t1`.`member_id` JOIN `roles` AS `t2` ON `t2`.`role_id` = `t3`.`role_id` WHERE (`t2`.`name` = ?)",
        values: ["admin"],
      });

    expect(compileMysqlQuery(
        {
          query: parseQueryMethod("countDistinctByTeamLabelIgnoreCase"),
          args: ["PLATFORM"],
        },
        { entity: Member },
      )).toEqual({
        text:
          "SELECT COUNT(DISTINCT `t0`.`member_id`) AS `count` FROM `members` AS `t0` JOIN `teams` AS `t1` ON `t0`.`team_id` = `t1`.`team_id` WHERE (LOWER(`t1`.`label`) = ?)",
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
          "SELECT `t0`.* FROM `members` AS `t0` JOIN `member_roles` AS `t2` ON `t2`.`member_id` = `t0`.`member_id` JOIN `roles` AS `t1` ON `t1`.`role_id` = `t2`.`role_id` WHERE (`t1`.`name` = ?)",
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
          "DELETE `t0` FROM `members` AS `t0` JOIN `teams` AS `t1` ON `t0`.`team_id` = `t1`.`team_id` WHERE (`t1`.`label` = ?)",
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
    expect(compileMysqlInsert(
        { id: 0, name: "desk" },
        { entity: GeneratedProduct },
      )).toEqual({
        text:
          "INSERT INTO `shop`.`generated_products` (`product_name`) VALUES (?)",
        values: ["desk"],
      });
    expect(compileMysqlInsert(
        { id: 1, priority: "HIGH" },
        { entity: OrdinalTask },
      )).toEqual({
        text:
          "INSERT INTO `ordinal_tasks` (`id`, `priority`) VALUES (?, ?)",
        values: [1, 1],
      });
    expect(compileMysqlInsert(
        { id: 1, tags: ["new", "sale"] },
        { entity: ArrayTask },
      )).toEqual({
        text:
          "INSERT INTO `array_tasks` (`id`, `tags`) VALUES (?, ?)",
        values: [1, "[\"new\",\"sale\"]"],
      });
    expect(getMysqlPrimaryKeyValue(
        { id: 0, name: "desk" },
        { entity: GeneratedProduct },
      )).toBeUndefined();
    expect(compileMysqlUpdate(
        1,
        { id: 1, name: "chair", createdAt: 11 },
        { entity: Product },
      )).toEqual({
        text:
          "UPDATE `shop`.`products` SET `product_name` = ?, `created_at` = ? WHERE `product_id` = ?",
        values: ["chair", 11, 1],
      });
    expect(compileMysqlUpdate(
        1,
        { priority: "LOW" },
        { entity: OrdinalTask },
      )).toEqual({
        text:
          "UPDATE `ordinal_tasks` SET `priority` = ? WHERE `id` = ?",
        values: [0, 1],
      });
    expect(compileMysqlUpdate(
        1,
        { tags: ["clearance"] },
        { entity: ArrayTask },
      )).toEqual({
        text:
          "UPDATE `array_tasks` SET `tags` = ? WHERE `id` = ?",
        values: ["[\"clearance\"]", 1],
      });
    expect(() =>
        compileMysqlInsert(
          { id: 1, tags: "new" as unknown as string[] },
          { entity: ArrayTask },
        )).toThrow(/requires an array value/);
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

  test("compiles MySQL composite primary key CRUD SQL", () => {
    const options = { entity: TenantUser };
    const id = { tenantId: "t1", userId: "u1" };

    expect(compileMysqlFindById(id, options)).toEqual({
      text:
        "SELECT * FROM `tenant_users` WHERE `tenant_id` = ? AND `user_id` = ? LIMIT 1",
      values: ["t1", "u1"],
    });
    expect(compileMysqlUpdate(id, { name: "kim" }, options)).toEqual({
      text:
        "UPDATE `tenant_users` SET `name` = ? WHERE `tenant_id` = ? AND `user_id` = ?",
      values: ["kim", "t1", "u1"],
    });
    expect(compileMysqlDeleteById(id, options)).toEqual({
      text:
        "DELETE FROM `tenant_users` WHERE `tenant_id` = ? AND `user_id` = ?",
      values: ["t1", "u1"],
    });
  });

  test("compiles MySQL composite relation key SQL", () => {
    expect(
      compileMysqlInsert(
        {
          name: "kim",
          team: { tenantId: "t1", teamId: "team1" },
        },
        { entity: TenantMember },
      ),
    ).toEqual({
      text:
        "INSERT INTO `tenant_members` (`name`, `team_tenant_id`, `team_team_id`) VALUES (?, ?, ?)",
      values: ["kim", "t1", "team1"],
    });

    expect(
      compileMysqlQuery(
        {
          query: parseQueryMethod("findByTeam"),
          args: [{ tenantId: "t1", teamId: "team1" }],
        },
        { entity: TenantMember },
      ),
    ).toEqual({
      text:
        "SELECT * FROM `tenant_members` WHERE (`team_tenant_id` = ? AND `team_team_id` = ?)",
      values: ["t1", "team1"],
    });

    expect(
      compileMysqlQuery(
        {
          query: parseQueryMethod("findByTeamIn"),
          args: [[
            { tenantId: "t1", teamId: "team1" },
            { tenantId: "t1", teamId: "team2" },
          ]],
        },
        { entity: TenantMember },
      ),
    ).toEqual({
      text:
        "SELECT * FROM `tenant_members` WHERE ((`team_tenant_id`, `team_team_id`) IN ((?, ?), (?, ?)))",
      values: ["t1", "team1", "t1", "team2"],
    });

    expect(
      compileMysqlQuery(
        {
          query: parseQueryMethod("findByTeamLabel"),
          args: ["platform"],
        },
        { entity: TenantMember },
      ),
    ).toEqual({
      text:
        "SELECT `t0`.* FROM `tenant_members` AS `t0` JOIN `tenant_teams` AS `t1` ON `t0`.`team_tenant_id` = `t1`.`tenant_id` AND `t0`.`team_team_id` = `t1`.`team_id` WHERE (`t1`.`label` = ?)",
      values: ["platform"],
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
      adapter: mysql({ connection: asMysqlQueryable(queryable) }),
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

  test("logs MySQL SQL through NPA operations", async () => {
    const events = [];
    const slowQueries = [];
    const queryable = {
      async query(text, values) {
        return [[{ product_id: values[0], product_name: "desk" }], []];
      },
    };
    const npa = createNPA({
      adapter: mysql({ connection: asMysqlQueryable(queryable) }),
      operations: {
        logger: (event) => events.push(event),
        onSlowQuery: (event) => slowQueries.push(event),
        slowQueryThresholdMs: 0,
      },
      repositories: [ProductRepository],
    });
    const products = npa.get(ProductRepository) as ProductRepository & DynamicRepository;

    await products.findById(10);

    expect(events).toEqual([
      expect.objectContaining({
        adapter: "mysql",
        text:
          "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
        values: [10],
        success: true,
        rowCount: 1,
        durationMs: expect.any(Number),
      }),
    ]);
    expect(slowQueries).toEqual(events);
  });

  test("wraps MySQL driver errors with SQL context", async () => {
    const events = [];
    const driverError = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
      sqlState: "23000",
    });
    const queryable = {
      async query() {
        throw driverError;
      },
    };
    const npa = createNPA({
      adapter: mysql({ connection: asMysqlQueryable(queryable) }),
      operations: {
        logger: (event) => events.push(event),
      },
      repositories: [ProductRepository],
    });
    const products = npa.get(ProductRepository) as ProductRepository & DynamicRepository;

    await expect(products.findById(10)).rejects.toMatchObject({
      code: "NPA_DATABASE_UNIQUE_CONSTRAINT_FAILED",
      details: {
        adapter: "mysql",
        driverCode: "ER_DUP_ENTRY",
        errno: 1062,
        sqlState: "23000",
        text:
          "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
        values: [10],
      },
      name: "NPADatabaseError",
    });

    const error = await products.findById(10).catch((caught) => caught);
    expect(error).toBeInstanceOf(NPADatabaseError);
    expect(error.cause).toBe(driverError);
    expect(events[0]).toEqual(expect.objectContaining({
      adapter: "mysql",
      error: expect.any(NPADatabaseError),
      success: false,
      text:
        "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
      values: [10],
    }));
  });

  test("creates a transaction manager when MySQL adapter receives a connection", async () => {
    const calls = [];
    const adapter = mysql({
      connection: {
        query(text, values) {
          calls.push({ text, values });

          if (text.startsWith("SELECT")) {
            return [[{ product_id: values?.[0], product_name: "desk" }], []];
          }

          return [[], []];
        },
      },
    });
    const products = adapter.createRepository({
      entity: Product,
      repository: ProductRepository,
    }) as ProductRepository & DynamicRepository;

    expect(adapter.transactionManager).toBeDefined();
    await expect(
      adapter.transactionManager?.transactional(() => products.findById(10)),
    ).resolves.toEqual({
      product_id: 10,
      product_name: "desk",
    });
    expect(calls).toEqual([
      { text: "START TRANSACTION", values: undefined },
      {
        text:
          "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
        values: [10],
      },
      { text: "COMMIT", values: undefined },
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

    expect(await repository.save({ name: "desk", price: 120 })).toEqual({
      name: "desk",
      price: 120,
      product_id: 10,
    });
    expect(await repository.save({ id: 10, name: "table" })).toEqual({
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

  test("runs save and delete through a MySQL persistence context", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("INSERT")) {
          return [{ affectedRows: 1, insertId: 10 }, []];
        }

        if (text.startsWith("SELECT")) {
          return [[{ product_id: values[0], product_name: "desk" }], []];
        }

        return [{ affectedRows: 1 }, []];
      },
    };
    const repository = createMysqlDerivedQueryRepository(
      {},
      { entity: Product, queryable: asMysqlQueryable(queryable) },
    ) as NPARepository<Product, number>;
    const product = {
      name: "desk",
      price: 120,
      active: true,
      status: "active",
      createdAt: 1,
    } as Product;

    expect(await repository.save(product)).toBe(product);
    expect(product.id).toEqual(10);
    await repository.delete(product);

    expect(calls).toEqual([
      {
        text:
          "INSERT INTO `shop`.`products` (`product_name`, `price`, `active`, `status`, `created_at`) VALUES (?, ?, ?, ?, ?)",
        values: ["desk", 120, true, "active", 1],
      },
      {
        text:
          "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
        values: [10],
      },
      {
        text: "DELETE FROM `shop`.`products` WHERE `product_id` = ?",
        values: [10],
      },
    ]);
  });

  test("syncs MySQL many-to-many join rows during save and delete", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("INSERT INTO `members`")) {
          return [{ affectedRows: 1, insertId: 1 }, []];
        }

        if (text.startsWith("SELECT")) {
          return [[{ member_id: values[0], name: "kim" }], []];
        }

        return [{ affectedRows: 1 }, []];
      },
    };
    const repository = createMysqlDerivedQueryRepository(
      {},
      { entity: Member, queryable: asMysqlQueryable(queryable) },
    ) as NPARepository<Member, number>;
    const member = {
      name: "kim",
      roles: [{ id: 5, name: "admin" } as Role],
    } as Member;

    await repository.save(member);
    await repository.delete(member);

    expect(calls).toEqual([
      {
        text: "INSERT INTO `members` (`name`) VALUES (?)",
        values: ["kim"],
      },
      {
        text: "SELECT * FROM `members` WHERE `member_id` = ? LIMIT 1",
        values: [1],
      },
      {
        text: "DELETE FROM `member_roles` WHERE `member_id` = ?",
        values: [1],
      },
      {
        text:
          "INSERT IGNORE INTO `member_roles` (`member_id`, `role_id`) VALUES (?, ?)",
        values: [1, 5],
      },
      {
        text: "DELETE FROM `member_roles` WHERE `member_id` = ?",
        values: [1],
      },
      {
        text: "DELETE FROM `members` WHERE `member_id` = ?",
        values: [1],
      },
    ]);
  });

  test("treats falsy MySQL generated ids as unset on save", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("INSERT")) {
          return [{ affectedRows: 1, insertId: 8 }, []];
        }

        return [[{ product_id: values[0], product_name: "desk" }], []];
      },
    };
    const repository = createMysqlDerivedQueryRepository(
      {},
      { entity: GeneratedProduct, queryable: asMysqlQueryable(queryable) },
    ) as NPARepository<GeneratedProduct, number>;

    await expect(repository.save({ id: 0, name: "desk" })).resolves.toEqual({
      id: 8,
      name: "desk",
    });

    expect(calls).toEqual([
      {
        text:
          "INSERT INTO `shop`.`generated_products` (`product_name`) VALUES (?)",
        values: ["desk"],
      },
      {
        text:
          "SELECT * FROM `shop`.`generated_products` WHERE `product_id` = ? LIMIT 1",
        values: [8],
      },
    ]);
  });

  test("syncs inverse MySQL many-to-many join rows", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("INSERT INTO `roles`")) {
          return [{ affectedRows: 1, insertId: 5 }, []];
        }

        if (text.startsWith("SELECT")) {
          return [[{ role_id: values[0], name: "admin" }], []];
        }

        return [{ affectedRows: 1 }, []];
      },
    };
    const repository = createMysqlDerivedQueryRepository(
      {},
      { entity: Role, queryable: asMysqlQueryable(queryable) },
    ) as NPARepository<Role, number>;
    const role = {
      name: "admin",
      members: [{ id: 1, name: "kim" } as Member],
    } as Role;

    await repository.save(role);

    expect(calls).toEqual([
      {
        text: "INSERT INTO `roles` (`name`) VALUES (?)",
        values: ["admin"],
      },
      {
        text: "SELECT * FROM `roles` WHERE `role_id` = ? LIMIT 1",
        values: [5],
      },
      {
        text: "DELETE FROM `member_roles` WHERE `role_id` = ?",
        values: [5],
      },
      {
        text:
          "INSERT IGNORE INTO `member_roles` (`role_id`, `member_id`) VALUES (?, ?)",
        values: [5, 1],
      },
    ]);
  });

  test("runs MySQL direct and derived deletes through ORM cleanup when relations need it", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text.startsWith("SELECT")) {
          return [[{ member_id: values[0] === "kim" ? 2 : values[0], name: "kim" }], []];
        }

        return [{ affectedRows: 1 }, []];
      },
    };
    const repository = createMysqlDerivedQueryRepository(
      {},
      { entity: Member, queryable: asMysqlQueryable(queryable) },
    ) as NPARepository<Member, number> & {
      deleteByName(name: string): Promise<number>;
    };

    expect(await repository.deleteById(1)).toEqual(1);
    expect(await repository.deleteByName("kim")).toEqual(1);

    expect(calls).toEqual([
      {
        text: "SELECT * FROM `members` WHERE `member_id` = ? LIMIT 1",
        values: [1],
      },
      {
        text: "DELETE FROM `member_roles` WHERE `member_id` = ?",
        values: [1],
      },
      {
        text: "DELETE FROM `members` WHERE `member_id` = ?",
        values: [1],
      },
      {
        text: "SELECT DISTINCT * FROM `members` WHERE (`name` = ?)",
        values: ["kim"],
      },
      {
        text: "DELETE FROM `member_roles` WHERE `member_id` = ?",
        values: [2],
      },
      {
        text: "DELETE FROM `members` WHERE `member_id` = ?",
        values: [2],
      },
    ]);
  });

  test("uses timestamp decorators for MySQL insert defaults and update touches", async () => {
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

        return [[{ product_id: values[0], product_name: "chair" }], []];
      },
    };
    const repository = createMysqlDerivedQueryRepository(
      {},
      { entity: TimestampedProduct, queryable: asMysqlQueryable(queryable) },
    ) as NPARepository<Record<string, unknown>, number>;

    await repository.save({ name: "desk" });
    await repository.save({ id: 10, name: "chair" });

    expect(calls).toEqual([
      {
        text:
          "INSERT INTO `shop`.`products` (`product_name`) VALUES (?)",
        values: ["desk"],
      },
      {
        text:
          "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
        values: [10],
      },
      {
        text:
          "UPDATE `shop`.`products` SET `product_name` = ?, `updated_at` = ? WHERE `product_id` = ?",
        values: ["chair", expect.any(Date), 10],
      },
      {
        text:
          "SELECT * FROM `shop`.`products` WHERE `product_id` = ? LIMIT 1",
        values: [10],
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

    await versioned.save({ id: 10, name: "chair", version: 0 });
    await plain.save({ id: 11, name: "desk" });

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
          return [[{ team_id: 2, label: "core", organization_id: 3 }], []];
        }

        if (text === "SELECT * FROM `organizations` WHERE `organization_id` IN (?)") {
          return [[{ organization_id: 3, name: "platform" }], []];
        }

        if (text.includes("FROM `member_roles` j")) {
          return [[
            { __source_id: 10, role_id: 7, name: "admin" },
            { __source_id: 10, role_id: 8, name: "writer" },
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
    const loadedMembers = createMysqlDerivedQueryRepository(
      Object.create(MemberByIdGraphRepository.prototype),
      { entity: Member, queryable: asMysqlQueryable(queryable) },
    );
    const teams = createMysqlDerivedQueryRepository(
      Object.create(TeamMembersGraphRepository.prototype),
      { entity: Team, queryable: asMysqlQueryable(queryable) },
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

  test("loads MySQL @EntityGraph relations only for decorated repository methods", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text === "SELECT * FROM `members` WHERE (`name` = ?)") {
          return [[{ member_id: 10, name: values[0], team_id: 2 }], []];
        }

        if (text === "SELECT * FROM `members` WHERE (`name` = ?) ORDER BY `member_id` ASC LIMIT 2") {
          return [[{ member_id: 10, name: values[0], team_id: 2 }], []];
        }

        if (text === "SELECT * FROM `teams` WHERE `team_id` IN (?)") {
          return [[{ team_id: 2, label: "core", organization_id: 3 }], []];
        }

        if (text === "SELECT * FROM `organizations` WHERE `organization_id` IN (?)") {
          return [[{ organization_id: 3, name: "platform" }], []];
        }

        if (text.includes("FROM `member_roles` j")) {
          return [[
            { __source_id: 10, role_id: 7, name: "admin" },
            { __source_id: 10, role_id: 8, name: "writer" },
          ], []];
        }

        throw new Error(`Unexpected query: ${text}`);
      },
    };
    const repository = createMysqlDerivedQueryRepository(
      Object.create(MemberGraphRepository.prototype),
      { entity: Member, queryable: asMysqlQueryable(queryable) },
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
    ) as any;
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

  test("loads MySQL eager relations without @EntityGraph", async () => {
    const calls = [];
    const queryable = {
      async query(text, values) {
        calls.push({ text, values });

        if (text === "SELECT * FROM `eager_members` WHERE `member_id` = ? LIMIT 1") {
          return [[{ member_id: values[0], name: "kim", team_id: 2 }], []];
        }

        if (text === "SELECT * FROM `eager_teams` WHERE `team_id` IN (?)") {
          return [[{ team_id: 2, label: "core" }], []];
        }

        if (text === "SELECT * FROM `eager_members` WHERE `team_id` IN (?)") {
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
      { entity: EagerMember, queryable: asMysqlQueryable(queryable) },
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

function cursorToken(values: unknown[]): string {
  return Buffer.from(JSON.stringify({ v: 1, values }), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
