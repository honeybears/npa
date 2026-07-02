import { describe, expect, test } from "@jest/globals";
import {
  Column,
  Entity,
  Id,
  Index,
  ManyToMany,
  ManyToOne,
  NPARepository,
  OneToMany,
  RelationKind,
  Unique,
  Version,
  getEntityMetadata,
  parseQueryMethod,
} from "../dist";
import {
  compilePostgresqlInsert,
  compilePostgresqlQuery,
  createPostgresqlDerivedQueryRepository,
  type PostgresqlQueryable,
} from "../packages/pg/dist";

type DynamicUserRepository = NPARepository<Record<string, unknown>, unknown> & {
  findByName(name: string): Promise<Record<string, unknown>[]>;
};

@Entity({ name: "teams" })
class Team {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  name!: string;

  @OneToMany(() => User, { mappedBy: "team" })
  users?: User[];
}

@Entity({ name: "roles" })
class Role {
  @Id({ name: "role_id" })
  id!: number;

  @Column()
  name!: string;

  @ManyToMany(() => User, { mappedBy: "roles" })
  users?: User[];
}

@Entity({ name: "npa_users", schema: "app" })
@Index({ name: "idx_users_name_created_at", columns: ["name", "createdAt"] })
class User {
  @Id({ name: "user_id" })
  id!: number;

  @Unique({ name: "uidx_users_full_name" })
  @Column({ name: "full_name" })
  name!: string;

  @Column({ name: "created_at", index: "idx_users_created_at" })
  createdAt!: number;

  @Version({ name: "lock_version" })
  version!: number;

  @ManyToOne(() => Team, { joinColumn: "team_id" })
  team?: Team;

  @ManyToMany(() => Role, { joinTable: "user_roles" })
  roles?: Role[];
}

describe("entity metadata", () => {
  describe("decorator metadata", () => {
    test("registers JPA-style entity metadata including relations", () => {
      const metadata = getEntityMetadata(User);

      expect(metadata.tableName).toEqual("npa_users");
      expect(metadata.schema).toEqual("app");
      expect(
        metadata.columns.map((column) => ({
          propertyName: column.propertyName,
          columnName: column.columnName,
          primary: column.primary,
          version: column.version,
        })),
      ).toEqual([
        {
          propertyName: "id",
          columnName: "user_id",
          primary: true,
          version: false,
        },
        {
          propertyName: "name",
          columnName: "full_name",
          primary: false,
          version: false,
        },
        {
          propertyName: "createdAt",
          columnName: "created_at",
          primary: false,
          version: false,
        },
        {
          propertyName: "version",
          columnName: "lock_version",
          primary: false,
          version: true,
        },
      ]);
      expect(metadata.versionColumn?.propertyName).toEqual("version");
      expect(metadata.versionColumn?.columnName).toEqual("lock_version");
      expect(
        metadata.indexes.map((index) => ({
          name: index.name,
          propertyNames: index.propertyNames,
          unique: index.unique,
        })),
      ).toEqual([
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
      ]);
      expect(
        metadata.relations.map((relation) => ({
          propertyName: relation.propertyName,
          kind: relation.kind,
          joinColumn: relation.joinColumn,
          joinTable: relation.joinTable,
        })),
      ).toEqual([
        {
          propertyName: "team",
          kind: RelationKind.MANY_TO_ONE,
          joinColumn: "team_id",
          joinTable: undefined,
        },
        {
          propertyName: "roles",
          kind: RelationKind.MANY_TO_MANY,
          joinColumn: undefined,
          joinTable: "user_roles",
        },
      ]);
    });
  });

  describe("PostgreSQL compiler mapping", () => {
    test("uses entity metadata for PostgreSQL insert and derived query mapping", () => {
      expect(
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
      ).toEqual({
        text: 'INSERT INTO "app"."npa_users" ("full_name", "created_at", "team_id", "lock_version") VALUES ($1, $2, $3, $4) RETURNING *',
        values: ["kim", 10, 1, 0],
      });

      expect(
        compilePostgresqlQuery(
          {
            query: parseQueryMethod("findByNameAndCreatedAtGreaterThan"),
            args: ["kim", 1],
          },
          { entity: User },
        ),
      ).toEqual({
        text: 'SELECT * FROM "app"."npa_users" WHERE ("full_name" = $1 AND "created_at" > $2)',
        values: ["kim", 1],
      });
    });
  });

  describe("repository factory", () => {
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
        {
          entity: User,
          queryable: queryable as unknown as PostgresqlQueryable,
        },
      ) as DynamicUserRepository;

      expect(await repository.insert({ name: "kim", createdAt: 10 })).toEqual({
        user_id: 1,
        full_name: "kim",
        created_at: 10,
      });
      await repository.findByName("kim");

      expect(calls).toEqual([
        {
          text: 'INSERT INTO "app"."npa_users" ("full_name", "created_at", "lock_version") VALUES ($1, $2, $3) RETURNING *',
          values: ["kim", 10, 0],
        },
        {
          text: 'SELECT * FROM "app"."npa_users" WHERE ("full_name" = $1)',
          values: ["kim"],
        },
      ]);
    });
  });
});
