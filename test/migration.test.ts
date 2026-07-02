import { describe, expect, test } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NPAMigrationRelationKind,
  createMigrationChecksum,
  createMigrationChecksumFromSql,
  discoverEntitySchemas,
  formatMigrationSql,
  loadMigrationFiles,
  loadNPAMigrationConfig,
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
        kind: NPAMigrationRelationKind.MANY_TO_ONE,
        targetClassName: "Category",
        mappedBy: undefined,
        joinColumn: "primary_category_id",
        joinTable: undefined,
        foreignKeyName: "fk_products_primary_category",
        onDelete: "SET NULL",
        onUpdate: undefined,
      },
      {
        propertyName: "categories",
        kind: NPAMigrationRelationKind.MANY_TO_MANY,
        targetClassName: "Category",
        mappedBy: undefined,
        joinColumn: undefined,
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
        propertyName: "version",
        columnName: "lock_version",
        tsType: "number",
        dbType: undefined,
        nullable: false,
        primary: false,
        version: true,
      },
    ]);
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
          '  "category_id" SERIAL PRIMARY KEY,',
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
          '  "product_id" SERIAL PRIMARY KEY,',
          '  "product_name" VARCHAR(80) NOT NULL,',
          '  "description" TEXT,',
          '  "active" BOOLEAN NOT NULL DEFAULT TRUE,',
          '  "created_at" TIMESTAMPTZ NOT NULL,',
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
        "  `category_id` INT AUTO_INCREMENT PRIMARY KEY,",
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
        "  `product_id` INT AUTO_INCREMENT PRIMARY KEY,",
        "  `product_name` VARCHAR(80) NOT NULL,",
        "  `description` VARCHAR(255),",
        "  `active` BOOLEAN NOT NULL DEFAULT TRUE,",
        "  `created_at` DATETIME(3) NOT NULL,",
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

    expect(await loadNPAMigrationConfig({ cwd: root })).toEqual({
      adapter: "postgresql",
      url: "postgresql://localhost/db",
      entities: ["models/**/*.entity.ts"],
      migrations: { dir: "database/migrations", table: "custom_migrations" },
    });

    expect(
      await loadNPAMigrationConfig({
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
    );

    expect(migration.name).toMatch(/^\d{14}_init_products$/);
    expect(path.basename(migration.filePath)).toEqual("migration.sql");
    expect(migration.statementCount).toEqual(2);
    expect(fs.readFileSync(migration.filePath, "utf8")).toEqual(
      `${statements[0]};\n\n${statements[1]};\n`,
    );
    expect(migration.checksum).toEqual(
      createMigrationChecksumFromSql(formatMigrationSql(statements)),
    );
    expect(JSON.stringify(loadMigrationFiles(root, "npa/migrations"))).toEqual(
      JSON.stringify([migration]),
    );
  });
});

function makeMigrationFixture() {
  const root = makeTempRoot();
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, "product.entity.ts"),
    `
import { Column, Entity, Id, Index, ManyToMany, ManyToOne, ReferentialAction, Version } from "@npa/test";

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

  @Column({ name: "created_at" })
  createdAt!: Date;

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
