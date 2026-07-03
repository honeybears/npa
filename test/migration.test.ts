import { describe, expect, test } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MigrationRelationKind,
  assertSafeMigrationStatements,
  createMigrationChecksum,
  createMigrationChecksumFromSql,
  createDownMigrationStatements,
  discoverEntitySchemas,
  findDestructiveMigrationStatements,
  formatMigrationSql,
  loadMigrationFiles,
  loadMigrationConfig,
  parseEntitySchemas,
  writeMigrationFile,
} from "../src";
import { compilePostgresqlMigrationStatements } from "../packages/pg/src/postgresql-migration";
import { compileMysqlMigrationStatements } from "../packages/mysql/src/mysql-migration";

describe("migration metadata", () => {
  test("parses entity source files into migration schemas", () => {
    const root = makeMigrationFixture();
    const schemas = discoverEntitySchemas(root, ["src/**/*.entity.ts"]);
    const product = schemas.find((schema) => schema.className === "Product");

    expect(schemas.length).toEqual(2);
    expect(product).toBeTruthy();
    expect(product.tableName).toEqual("products");
    expect(product.schema).toEqual("shop");
    expect(product.indexes).toEqual([
      {
        name: "idx_products_active",
        columns: ["active"],
        unique: false,
      },
      {
        name: "idx_products_active_created_at",
        columns: ["active", "created_at"],
        unique: false,
      },
      {
        name: "uidx_products_name",
        columns: ["product_name"],
        unique: true,
      },
      {
        name: "uidx_products_name_created_at",
        columns: ["product_name", "created_at"],
        unique: true,
      },
    ]);
    expect(product.relations).toEqual([
      {
        propertyName: "primaryCategory",
        kind: MigrationRelationKind.MANY_TO_ONE,
        targetClassName: "Category",
        mappedBy: undefined,
        joinColumn: "primary_category_id",
        joinColumns: undefined,
        joinTable: undefined,
        foreignKeyName: "fk_products_primary_category",
        onDelete: "SET NULL",
        onUpdate: undefined,
      },
      {
        propertyName: "categories",
        kind: MigrationRelationKind.MANY_TO_MANY,
        targetClassName: "Category",
        mappedBy: undefined,
        joinColumn: undefined,
        joinColumns: undefined,
        joinTable: "product_categories",
        foreignKeyName: undefined,
        onDelete: undefined,
        onUpdate: undefined,
      },
    ]);
    expect(
      product.columns.map((column) => ({
        propertyName: column.propertyName,
        columnName: column.columnName,
        tsType: column.tsType,
        dbType: column.dbType,
        nullable: column.nullable,
        primary: column.primary,
        version: column.version,
      })),
    ).toEqual([
      {
        propertyName: "id",
        columnName: "product_id",
        tsType: "number",
        dbType: undefined,
        nullable: false,
        primary: true,
        version: false,
      },
      {
        propertyName: "name",
        columnName: "product_name",
        tsType: "string",
        dbType: "VARCHAR(80)",
        nullable: false,
        primary: false,
        version: false,
      },
      {
        propertyName: "description",
        columnName: "description",
        tsType: "string | null",
        dbType: undefined,
        nullable: true,
        primary: false,
        version: false,
      },
      {
        propertyName: "active",
        columnName: "active",
        tsType: "boolean",
        dbType: undefined,
        nullable: false,
        primary: false,
        version: false,
      },
      {
        propertyName: "createdAt",
        columnName: "created_at",
        tsType: "Date",
        dbType: undefined,
        nullable: false,
        primary: false,
        version: false,
      },
      {
        propertyName: "updatedAt",
        columnName: "updated_at",
        tsType: "Date",
        dbType: undefined,
        nullable: false,
        primary: false,
        version: false,
      },
      {
        propertyName: "version",
        columnName: "lock_version",
        tsType: "number",
        dbType: undefined,
        nullable: false,
        primary: false,
        version: true,
      },
    ]);
    expect(product.columns.find((column) => column.propertyName === "createdAt"))
      .toMatchObject({ createdAt: true, defaultCurrentTimestamp: true });
    expect(product.columns.find((column) => column.propertyName === "updatedAt"))
      .toMatchObject({ updatedAt: true, defaultCurrentTimestamp: true });
  });

  test("rejects duplicate migration metadata names", () => {
    expect(() =>
      parseEntitySource(`
  @Entity()
  export class Product {
    @Id()
    id?: number;

    @Column({ name: "sku" })
    sku!: string;

    @Column({ name: "sku" })
    legacySku!: string;
  }
  `),
    ).toThrow(/Duplicate column name "sku" in Product: sku and legacySku/);

    expect(() =>
      parseEntitySource(`
  @Index({ name: "idx_products_sku", columns: ["sku"] })
  @Entity()
  export class Product {
    @Id()
    id?: number;

    @Column({ index: "idx_products_sku" })
    sku!: string;
  }
  `),
    ).toThrow(/Duplicate index name "idx_products_sku" in Product/);

    expect(() =>
      parseEntitySource(`
  @Entity()
  export class Category {
    @Id()
    id?: number;
  }

  @Entity()
  export class Product {
    @Id()
    id?: number;

    @ManyToOne(() => Category)
    category?: Category;

    @ManyToMany(() => Category)
    category?: Category[];
  }
  `),
    ).toThrow(/Duplicate relation property "category" in Product/);

    expect(() =>
      parseEntitySource(`
  @Entity()
  export class Category {
    @Id()
    id?: number;
  }

  @Entity()
  export class Product {
    @Id()
    id?: number;

    @ManyToOne(() => Category, { foreignKeyName: "fk_products_category" })
    primaryCategory?: Category;

    @ManyToOne(() => Category, { foreignKeyName: "fk_products_category" })
    secondaryCategory?: Category;
  }
  `),
    ).toThrow(
      /Duplicate relation foreign key name "fk_products_category" in Product/,
    );
  });

  test("parses nullable custom database column types and defaults", () => {
    const [schema] = parseEntitySource(`
  @Entity({ name: "events" })
  export class Event {
    @Id()
    id?: number;

    @Column({ type: "VARCHAR(32)", nullable: true, default: "pending" })
    code?: string | null;
  }
  `);

    expect(
      schema.columns.find((column) => column.propertyName === "code"),
    ).toEqual({
      propertyName: "code",
      columnName: "code",
      tsType: "string | null",
      dbType: "VARCHAR(32)",
      defaultValue: "pending",
      nullable: true,
      primary: false,
      version: false,
    });
  });

  test("parses explicit id generation strategy metadata", () => {
    const [schema] = parseEntitySource(`
  @Entity({ name: "events" })
  export class Event {
    @Id({ generationStrategy: GenerationStrategy.SEQUENCE, sequenceName: "event_id_seq" })
    id?: number;

    @Column()
    name!: string;
  }
  `);

    expect(schema.columns.find((column) => column.propertyName === "id"))
      .toMatchObject({
        propertyName: "id",
        columnName: "id",
        primary: true,
        generationStrategy: "SEQUENCE",
        sequenceName: "event_id_seq",
      });

    const [uuidSchema] = parseEntitySource(`
  @Entity()
  export class ExternalEvent {
    @Id({ generationStrategy: "UUID" })
    id?: string;
  }
  `);

    expect(uuidSchema.columns[0]).toMatchObject({
      generationStrategy: "UUID",
    });
  });

  test("rejects dynamic decorator metadata for migrations", () => {
    const cases = [
      {
        source: `
  const TABLE = "products";
  @Entity(TABLE)
  export class Product {
    @Id()
    id?: number;
  }
  `,
        error: /must use a string literal or object literal/,
      },
      {
        source: `
  const NAME = "product_name";
  @Entity()
  export class Product {
    @Id()
    id?: number;

    @Column({ name: NAME })
    name!: string;
  }
  `,
        error: /@Column for Product\.name\.name must be a string literal/,
      },
      {
        source: `
  const DEFAULT_STATUS = "draft";
  @Entity()
  export class Product {
    @Id()
    id?: number;

    @Column({ default: DEFAULT_STATUS })
    status!: string;
  }
  `,
        error:
          /@Column for Product\.status\.default must be a string, number, boolean, or null literal/,
      },
      {
        source: `
  const COLUMNS = ["sku"];
  @Index({ name: "idx_products_sku", columns: COLUMNS })
  @Entity()
  export class Product {
    @Id()
    id?: number;

    @Column()
    sku!: string;
  }
  `,
        error:
          /@Index for Product\.columns must be an array of string literals/,
      },
      {
        source: `
  @Entity()
  export class Product {
    @Id()
    id?: number;

    @Index({ name: "idx_products_sku" })
    @Column()
    sku!: string;
  }
  `,
        error:
          /@Index for Product\.sku can only be used on entity classes/,
      },
      {
        source: `
  @Unique({ name: "uidx_products_sku" })
  @Entity()
  export class Product {
    @Id()
    id?: number;

    @Column()
    sku!: string;
  }
  `,
        error:
          /@Unique is not supported for Product/,
      },
      {
        source: `
  @Entity()
  export class Category {
    @Id()
    id?: number;
  }

  @Entity()
  export class Product {
    @Id()
    id?: number;

    @ManyToOne(() => resolveCategory())
    category?: Category;
  }
  `,
        error: /target must use a literal \(\) => EntityClass expression/,
      },
    ];

    for (const { source, error } of cases) {
      expect(() => parseEntitySource(source)).toThrow(error);
    }
  });

  test("parses one-to-one relations and creates unique owning foreign keys", () => {
    const schemas = parseEntitySource(`
      import { Column, Entity, Id, OneToOne } from "@npa/test";

      @Entity({ name: "users" })
      class User {
        @Id({ name: "user_id" })
        id!: number;

        @OneToOne(() => Profile, { mappedBy: "user" })
        profile!: Profile;
      }

      @Entity({ name: "profiles" })
      class Profile {
        @Id({ name: "profile_id" })
        id!: number;

        @Column()
        bio!: string;

        @OneToOne(() => User, { joinColumn: "user_id", foreignKeyName: "fk_profiles_user" })
        user!: User;
      }
    `);
    const profile = schemas.find((schema) => schema.className === "Profile");

    expect(profile?.relations).toEqual([
      {
        propertyName: "user",
        kind: MigrationRelationKind.ONE_TO_ONE,
        targetClassName: "User",
        mappedBy: undefined,
        joinColumn: "user_id",
        joinColumns: undefined,
        joinTable: undefined,
        foreignKeyName: "fk_profiles_user",
        onDelete: undefined,
        onUpdate: undefined,
      },
    ]);
    expect(compilePostgresqlMigrationStatements({ entities: schemas })).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uidx_profiles_user_id" ON "profiles" ("user_id")',
    );
    expect(compilePostgresqlMigrationStatements({ entities: schemas })).toContain(
      'ALTER TABLE "profiles" ADD CONSTRAINT "fk_profiles_user" FOREIGN KEY ("user_id") REFERENCES "users" ("user_id")',
    );
    expect(compileMysqlMigrationStatements({ entities: schemas })).toContain(
      "CREATE UNIQUE INDEX `uidx_profiles_user_id` ON `profiles` (`user_id`)",
    );
    expect(compileMysqlMigrationStatements({ entities: schemas })).toContain(
      "ALTER TABLE `profiles` ADD CONSTRAINT `fk_profiles_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`)",
    );
  });

  test("creates composite relation foreign keys", () => {
    const schemas = parseEntitySource(`
      import { Column, Entity, Id, ManyToOne } from "@npa/test";

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
    `);

    const member = schemas.find((schema) => schema.className === "TenantMember");

    expect(member?.relations[0]).toMatchObject({
      propertyName: "team",
      joinColumn: undefined,
      joinColumns: undefined,
    });
    expect(compilePostgresqlMigrationStatements({ entities: schemas })).toContain(
      'ALTER TABLE "tenant_members" ADD CONSTRAINT "fk_tenant_members_team_tenant_id_team_team_id_tenant_teams" FOREIGN KEY ("team_tenant_id", "team_team_id") REFERENCES "tenant_teams" ("tenant_id", "team_id")',
    );
    expect(compileMysqlMigrationStatements({ entities: schemas })).toContain(
      "ALTER TABLE `tenant_members` ADD CONSTRAINT `fk_tenant_members_team_tenant_id_team_team_id_tenant_teams` FOREIGN KEY (`team_tenant_id`, `team_team_id`) REFERENCES `tenant_teams` (`tenant_id`, `team_id`)",
    );
  });

  test("compiles PostgreSQL and MySQL schema migration SQL", () => {
    const schemas = discoverEntitySchemas(makeMigrationFixture(), [
      "src/**/*.entity.ts",
    ]);

    expect(compilePostgresqlMigrationStatements({ entities: schemas })).toEqual(
      [
        [
          'CREATE TABLE IF NOT EXISTS "_npa_migrations" (',
          "  name TEXT PRIMARY KEY,",
          "  checksum TEXT NOT NULL,",
          "  adapter TEXT NOT NULL,",
          "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
          "  statement_count INTEGER NOT NULL",
          ")",
        ].join("\n"),
        'CREATE SCHEMA IF NOT EXISTS "shop"',
        [
          'CREATE TABLE IF NOT EXISTS "shop"."categories" (',
          '  "category_id" INTEGER PRIMARY KEY,',
          '  "label" TEXT NOT NULL',
          ")",
        ].join("\n"),
        [
          'CREATE TABLE IF NOT EXISTS "shop"."product_categories" (',
          '  "product_id" INTEGER NOT NULL,',
          '  "category_id" INTEGER NOT NULL,',
          '  PRIMARY KEY ("product_id", "category_id")',
          ")",
        ].join("\n"),
        [
          'CREATE TABLE IF NOT EXISTS "shop"."products" (',
          '  "product_id" INTEGER PRIMARY KEY,',
          '  "product_name" VARCHAR(80) NOT NULL,',
          '  "description" TEXT,',
          '  "active" BOOLEAN NOT NULL DEFAULT TRUE,',
          '  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,',
          '  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,',
          '  "lock_version" INTEGER NOT NULL,',
          '  "primary_category_id" INTEGER',
          ")",
        ].join("\n"),
        'CREATE INDEX IF NOT EXISTS "idx_products_active" ON "shop"."products" ("active")',
        'CREATE INDEX IF NOT EXISTS "idx_products_active_created_at" ON "shop"."products" ("active", "created_at")',
        'CREATE UNIQUE INDEX IF NOT EXISTS "uidx_products_name" ON "shop"."products" ("product_name")',
        'CREATE UNIQUE INDEX IF NOT EXISTS "uidx_products_name_created_at" ON "shop"."products" ("product_name", "created_at")',
        'ALTER TABLE "shop"."product_categories" ADD CONSTRAINT "fk_product_categories_category_id_categories" FOREIGN KEY ("category_id") REFERENCES "shop"."categories" ("category_id")',
        'ALTER TABLE "shop"."product_categories" ADD CONSTRAINT "fk_product_categories_product_id_products" FOREIGN KEY ("product_id") REFERENCES "shop"."products" ("product_id")',
        'ALTER TABLE "shop"."products" ADD CONSTRAINT "fk_products_primary_category" FOREIGN KEY ("primary_category_id") REFERENCES "shop"."categories" ("category_id") ON DELETE SET NULL',
      ],
    );

    expect(compileMysqlMigrationStatements({ entities: schemas })).toEqual([
      [
        "CREATE TABLE IF NOT EXISTS `_npa_migrations` (",
        "  name VARCHAR(255) PRIMARY KEY,",
        "  checksum VARCHAR(64) NOT NULL,",
        "  adapter VARCHAR(32) NOT NULL,",
        "  applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),",
        "  statement_count INT NOT NULL",
        ")",
      ].join("\n"),
      "CREATE DATABASE IF NOT EXISTS `shop`",
      [
        "CREATE TABLE IF NOT EXISTS `shop`.`categories` (",
        "  `category_id` INT PRIMARY KEY,",
        "  `label` VARCHAR(255) NOT NULL",
        ")",
      ].join("\n"),
      [
        "CREATE TABLE IF NOT EXISTS `shop`.`product_categories` (",
        "  `product_id` INT NOT NULL,",
        "  `category_id` INT NOT NULL,",
        "  PRIMARY KEY (`product_id`, `category_id`)",
        ")",
      ].join("\n"),
      [
        "CREATE TABLE IF NOT EXISTS `shop`.`products` (",
        "  `product_id` INT PRIMARY KEY,",
        "  `product_name` VARCHAR(80) NOT NULL,",
        "  `description` VARCHAR(255),",
        "  `active` BOOLEAN NOT NULL DEFAULT TRUE,",
        "  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),",
        "  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),",
        "  `lock_version` INT NOT NULL,",
        "  `primary_category_id` INT",
        ")",
      ].join("\n"),
      "CREATE INDEX `idx_products_active` ON `shop`.`products` (`active`)",
      "CREATE INDEX `idx_products_active_created_at` ON `shop`.`products` (`active`, `created_at`)",
      "CREATE UNIQUE INDEX `uidx_products_name` ON `shop`.`products` (`product_name`)",
      "CREATE UNIQUE INDEX `uidx_products_name_created_at` ON `shop`.`products` (`product_name`, `created_at`)",
      "ALTER TABLE `shop`.`product_categories` ADD CONSTRAINT `fk_product_categories_category_id_categories` FOREIGN KEY (`category_id`) REFERENCES `shop`.`categories` (`category_id`)",
      "ALTER TABLE `shop`.`product_categories` ADD CONSTRAINT `fk_product_categories_product_id_products` FOREIGN KEY (`product_id`) REFERENCES `shop`.`products` (`product_id`)",
      "ALTER TABLE `shop`.`products` ADD CONSTRAINT `fk_products_primary_category` FOREIGN KEY (`primary_category_id`) REFERENCES `shop`.`categories` (`category_id`) ON DELETE SET NULL",
    ]);
  });

  test("creates deterministic migration checksums", () => {
    const schemas = discoverEntitySchemas(makeMigrationFixture(), [
      "src/**/*.entity.ts",
    ]);
    const reordered = schemas.map((schema) => ({
      ...schema,
      columns: [...schema.columns].reverse(),
      indexes: [...schema.indexes].reverse(),
      relations: [...schema.relations].reverse(),
    }));

    expect(createMigrationChecksum("postgresql", schemas)).toEqual(
      createMigrationChecksum("postgresql", reordered.reverse()),
    );
    expect(createMigrationChecksum("postgresql", schemas)).not.toEqual(
      createMigrationChecksum("mysql", schemas),
    );
  });

  test("loads migration config and applies CLI overrides", async () => {
    const root = makeTempRoot();
    fs.writeFileSync(
      path.join(root, "npa.config.mjs"),
      `export default {
        adapter: "postgresql",
        url: "postgresql://localhost/db",
        entities: ["models/**/*.entity.ts"],
        migrations: { dir: "database/migrations", table: "custom_migrations" }
      };`,
      "utf8",
    );

    expect(await loadMigrationConfig({ cwd: root })).toEqual({
      adapter: "postgresql",
      url: "postgresql://localhost/db",
      entities: ["models/**/*.entity.ts"],
      migrations: { dir: "database/migrations", table: "custom_migrations" },
    });

    expect(
      await loadMigrationConfig({
        cwd: root,
        adapter: "mysql",
        url: "mysql://localhost/db",
        entities: ["src/**/*.entity.ts"],
      }),
    ).toEqual({
      adapter: "mysql",
      url: "mysql://localhost/db",
      entities: ["src/**/*.entity.ts"],
      migrations: { dir: "database/migrations", table: "custom_migrations" },
    });
  });

  test("writes and loads migration SQL files deterministically", () => {
    const root = makeTempRoot();
    const statements = [
      "CREATE TABLE products (id INT PRIMARY KEY)",
      "ALTER TABLE products ADD COLUMN name TEXT",
    ];
    const migration = writeMigrationFile(
      root,
      "npa/migrations",
      "Init Products",
      statements,
      {
        downStatements: [
          "ALTER TABLE products DROP COLUMN name",
          "DROP TABLE products",
        ],
      },
    );

    expect(migration.name).toMatch(/^\d{14}_init_products$/);
    expect(path.basename(migration.filePath)).toEqual("migration.sql");
    expect(path.basename(migration.downFilePath ?? "")).toEqual("down.sql");
    expect(migration.statementCount).toEqual(2);
    expect(migration.downStatementCount).toEqual(2);
    expect(fs.readFileSync(migration.filePath, "utf8")).toEqual(
      `${statements[0]};\n\n${statements[1]};\n`,
    );
    expect(fs.readFileSync(migration.downFilePath ?? "", "utf8")).toEqual(
      "ALTER TABLE products DROP COLUMN name;\n\nDROP TABLE products;\n",
    );
    expect(migration.checksum).toEqual(
      createMigrationChecksumFromSql(formatMigrationSql(statements)),
    );
    expect(JSON.stringify(loadMigrationFiles(root, "npa/migrations"))).toEqual(
      JSON.stringify([migration]),
    );
  });

  test("detects destructive migration statements unless explicitly allowed", () => {
    const statements = [
      "ALTER TABLE products DROP COLUMN legacy_code",
      "ALTER TABLE products ALTER COLUMN name TYPE TEXT USING name::TEXT",
    ];

    expect(findDestructiveMigrationStatements(statements)).toEqual([
      {
        statement: statements[0],
        reason: "drops a column",
      },
      {
        statement: statements[1],
        reason: "changes a column type",
      },
    ]);
    expect(() => assertSafeMigrationStatements(statements)).toThrow(
      /--allow-destructive/,
    );
    expect(() =>
      assertSafeMigrationStatements(statements, { allowDestructive: true }),
    ).not.toThrow();
  });

  test("creates best-effort down migration statements", () => {
    expect(createDownMigrationStatements("postgresql", [
      'CREATE TABLE IF NOT EXISTS "products" ("id" INTEGER PRIMARY KEY)',
      'ALTER TABLE "products" ADD COLUMN "name" TEXT',
      'ALTER TABLE "products" RENAME COLUMN "name" TO "display_name"',
    ])).toEqual([
      'ALTER TABLE "products" RENAME COLUMN "display_name" TO "name"',
      'ALTER TABLE "products" DROP COLUMN "name"',
      'DROP TABLE IF EXISTS "products"',
    ]);

    expect(createDownMigrationStatements("mysql", [
      "CREATE INDEX `idx_products_name` ON `products` (`name`)",
    ])).toEqual([
      "DROP INDEX `idx_products_name` ON `products`",
    ]);
  });
});

function makeMigrationFixture() {
  const root = makeTempRoot();
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, "product.entity.ts"),
    `
import { Column, CreatedAt, Entity, Id, Index, ManyToMany, ManyToOne, ReferentialAction, UpdatedAt, Version } from "@npa/test";

@Index([
  { name: "idx_products_active_created_at", columns: ["active", "createdAt"] },
  { name: "uidx_products_name_created_at", columns: ["name", "createdAt"], unique: true },
])
@Entity({ name: "products", schema: "shop" })
export class Product {
  @Id({ name: "product_id" })
  id?: number;

  @Column({ name: "product_name", type: "VARCHAR(80)", unique: "uidx_products_name" })
  name!: string;

  @Column({ nullable: true })
  description?: string | null;

  @Column({ index: "idx_products_active", default: true })
  active!: boolean;

  @CreatedAt({ name: "created_at" })
  createdAt!: Date;

  @UpdatedAt({ name: "updated_at" })
  updatedAt!: Date;

  @Version({ name: "lock_version" })
  version!: number;

  @ManyToOne(() => Category, { joinColumn: "primary_category_id", foreignKeyName: "fk_products_primary_category", onDelete: ReferentialAction.SET_NULL })
  primaryCategory?: Category;

  @ManyToMany(() => Category, { joinTable: "product_categories" })
  categories?: Category[];
}

@Entity({ name: "categories", schema: "shop" })
export class Category {
  @Id({ name: "category_id" })
  id?: number;

  @Column()
  label!: string;
}
`,
    "utf8",
  );
  return root;
}

function parseEntitySource(source) {
  const root = makeTempRoot();
  const filePath = path.join(root, "src", "test.entity.ts");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf8");

  return parseEntitySchemas(filePath);
}

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "npa-migration-"));
}
