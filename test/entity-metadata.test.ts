import { describe, expect, test } from "@jest/globals";
import {
  CascadeType,
  Column,
  CreatedAt,
  Entity,
  FetchType,
  GenerationStrategy,
  Id,
  Index,
  ManyToMany,
  ManyToOne,
  NPARepository,
  OneToOne,
  OneToMany,
  RelationKind,
  UpdatedAt,
  Version,
  getEntityMetadata,
  parseQueryMethod,
} from "../src";
import {
  compilePostgresqlInsert,
  compilePostgresqlQuery,
  createPostgresqlDerivedQueryRepository,
  type PostgresqlQueryable,
} from "../packages/pg/src";

type DynamicUserRepository = NPARepository<Record<string, unknown>, unknown> & {
  findByName(name: string): Promise<Record<string, unknown>[]>;
};

@Entity({ name: "teams" })
class Team {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  name!: string;

  @OneToMany(() => User, { mappedBy: "team", orphanRemoval: true })
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
@Index([
  { name: "idx_users_name_created_at", columns: ["name", "createdAt"] },
  { name: "uidx_users_name_created_at", columns: ["name", "createdAt"], unique: true },
])
class User {
  @Id({ name: "user_id" })
  id!: number;

  @Column({ name: "full_name", unique: "uidx_users_full_name" })
  name!: string;

  @CreatedAt({ name: "created_at", index: "idx_users_created_at" })
  createdAt!: number;

  @UpdatedAt({ name: "updated_at" })
  updatedAt!: Date;

  @Version({ name: "lock_version" })
  version!: number;

  @ManyToOne(() => Team, {
    joinColumn: "team_id",
    cascade: [CascadeType.PERSIST, CascadeType.REMOVE],
    fetch: FetchType.EAGER,
  })
  team?: Team;

  @ManyToMany(() => Role, { joinTable: "user_roles" })
  roles?: Role[];
}

@Entity()
class GeneratedIdUser {
  @Id({ generationStrategy: GenerationStrategy.UUID })
  id!: string;
}

@Entity({ name: "account_profiles" })
class AccountProfile {
  @Id({ name: "profile_id" })
  id!: number;

  @Column()
  label!: string;
}

@Entity({ name: "accounts" })
class Account {
  @Id({ name: "account_id" })
  id!: number;

  @OneToOne(() => AccountProfile, { joinColumn: "profile_id" })
  profile?: AccountProfile;
}

@Entity({ name: "tenant_users" })
class TenantUser {
  @Id({ name: "tenant_id" })
  tenantId!: string;

  @Id({ name: "user_id" })
  userId!: string;

  @Column()
  name!: string;
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
          createdAt: column.createdAt,
          updatedAt: column.updatedAt,
        })),
      ).toEqual([
        {
          propertyName: "id",
          columnName: "user_id",
          primary: true,
          version: false,
          createdAt: false,
          updatedAt: false,
        },
        {
          propertyName: "name",
          columnName: "full_name",
          primary: false,
          version: false,
          createdAt: false,
          updatedAt: false,
        },
        {
          propertyName: "createdAt",
          columnName: "created_at",
          primary: false,
          version: false,
          createdAt: true,
          updatedAt: false,
        },
        {
          propertyName: "updatedAt",
          columnName: "updated_at",
          primary: false,
          version: false,
          createdAt: false,
          updatedAt: true,
        },
        {
          propertyName: "version",
          columnName: "lock_version",
          primary: false,
          version: true,
          createdAt: false,
          updatedAt: false,
        },
      ]);
      expect(metadata.versionColumn?.propertyName).toEqual("version");
      expect(metadata.versionColumn?.columnName).toEqual("lock_version");
      expect(metadata.createdAtColumn?.propertyName).toEqual("createdAt");
      expect(metadata.updatedAtColumn?.propertyName).toEqual("updatedAt");
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
        {
          name: "uidx_users_name_created_at",
          propertyNames: ["name", "createdAt"],
          unique: true,
        },
      ]);
      expect(
        metadata.relations.map((relation) => ({
          propertyName: relation.propertyName,
          kind: relation.kind,
          joinColumn: relation.joinColumn,
          joinTable: relation.joinTable,
          nullable: relation.nullable,
          fetch: relation.fetch,
          cascade: relation.cascade,
          orphanRemoval: relation.orphanRemoval,
        })),
      ).toEqual([
        {
          propertyName: "team",
          kind: RelationKind.MANY_TO_ONE,
          joinColumn: "team_id",
          joinTable: undefined,
          nullable: true,
          fetch: FetchType.EAGER,
          cascade: [CascadeType.PERSIST, CascadeType.REMOVE],
          orphanRemoval: false,
        },
        {
          propertyName: "roles",
          kind: RelationKind.MANY_TO_MANY,
          joinColumn: undefined,
          joinTable: "user_roles",
          nullable: true,
          fetch: FetchType.LAZY,
          cascade: [],
          orphanRemoval: false,
        },
      ]);
      expect(getEntityMetadata(Team).relations[0]).toMatchObject({
        propertyName: "users",
        orphanRemoval: true,
      });
    });

    test("registers explicit id generation strategy metadata", () => {
      expect(getEntityMetadata(GeneratedIdUser).primaryColumn).toMatchObject({
        propertyName: "id",
        generationStrategy: GenerationStrategy.UUID,
      });
    });

    test("registers one-to-one and composite primary key metadata", () => {
      expect(getEntityMetadata(Account).relations[0]).toMatchObject({
        propertyName: "profile",
        kind: RelationKind.ONE_TO_ONE,
        joinColumn: "profile_id",
      });

      const metadata = getEntityMetadata(TenantUser);

      expect(metadata.primaryColumn?.propertyName).toEqual("tenantId");
      expect(metadata.primaryColumns.map((column) => column.propertyName)).toEqual([
        "tenantId",
        "userId",
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

      expect(await repository.save({ name: "kim", createdAt: 10 })).toEqual({
        user_id: 1,
        name: "kim",
        createdAt: 10,
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
