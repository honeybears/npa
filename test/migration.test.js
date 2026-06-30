const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createMigrationChecksum,
  createMigrationChecksumFromSql,
  discoverEntitySchemas,
  formatMigrationSql,
  loadMigrationFiles,
  loadNPAMigrationConfig,
  NPAMigrationRelationKind,
  parseEntitySchemas,
  writeMigrationFile,
} = require("../dist");
const {
  compilePostgresqlMigrationStatements,
} = require("../packages/pg/dist/postgresql-migration");
const {
  compileMysqlMigrationStatements,
} = require("../packages/mysql/dist/mysql-migration");

test("parses entity source files into migration schemas", () => {
  const root = makeMigrationFixture();
  const schemas = discoverEntitySchemas(root, ["src/**/*.entity.ts"]);
  const product = schemas.find((schema) => schema.className === "Product");

  assert.equal(schemas.length, 2);
  assert.ok(product);
  assert.equal(product.tableName, "products");
  assert.equal(product.schema, "shop");
  assert.deepEqual(product.indexes, [
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
  ]);
  assert.deepEqual(product.relations, [
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
  assert.deepEqual(
    product.columns.map((column) => ({
      propertyName: column.propertyName,
      columnName: column.columnName,
      tsType: column.tsType,
      dbType: column.dbType,
      nullable: column.nullable,
      primary: column.primary,
      version: column.version,
    })),
    [
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
    ],
  );
});

test("rejects dynamic decorator metadata for migrations", () => {
  const root = makeTempRoot();
  const filePath = path.join(root, "src", "bad.entity.ts");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `
const TABLE = "products";
@Entity(TABLE)
export class Product {
  @Id()
  id?: number;
}
`,
    "utf8",
  );

  assert.throws(
    () => parseEntitySchemas(filePath),
    /must use a string literal or object literal/,
  );
});

test("compiles PostgreSQL and MySQL schema migration SQL", () => {
  const schemas = discoverEntitySchemas(makeMigrationFixture(), ["src/**/*.entity.ts"]);

  assert.deepEqual(compilePostgresqlMigrationStatements({ entities: schemas }), [
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
      '  "active" BOOLEAN NOT NULL,',
      '  "created_at" TIMESTAMPTZ NOT NULL,',
      '  "lock_version" INTEGER NOT NULL,',
      '  "primary_category_id" INTEGER',
      ")",
    ].join("\n"),
    'CREATE INDEX IF NOT EXISTS "idx_products_active" ON "shop"."products" ("active")',
    'CREATE INDEX IF NOT EXISTS "idx_products_active_created_at" ON "shop"."products" ("active", "created_at")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "uidx_products_name" ON "shop"."products" ("product_name")',
    'ALTER TABLE "shop"."product_categories" ADD CONSTRAINT "fk_product_categories_category_id_categories" FOREIGN KEY ("category_id") REFERENCES "shop"."categories" ("category_id")',
    'ALTER TABLE "shop"."product_categories" ADD CONSTRAINT "fk_product_categories_product_id_products" FOREIGN KEY ("product_id") REFERENCES "shop"."products" ("product_id")',
    'ALTER TABLE "shop"."products" ADD CONSTRAINT "fk_products_primary_category" FOREIGN KEY ("primary_category_id") REFERENCES "shop"."categories" ("category_id") ON DELETE SET NULL',
  ]);

  assert.deepEqual(compileMysqlMigrationStatements({ entities: schemas }), [
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
      "  `active` BOOLEAN NOT NULL,",
      "  `created_at` DATETIME(3) NOT NULL,",
      "  `lock_version` INT NOT NULL,",
      "  `primary_category_id` INT",
      ")",
    ].join("\n"),
    "CREATE INDEX `idx_products_active` ON `shop`.`products` (`active`)",
    "CREATE INDEX `idx_products_active_created_at` ON `shop`.`products` (`active`, `created_at`)",
    "CREATE UNIQUE INDEX `uidx_products_name` ON `shop`.`products` (`product_name`)",
    "ALTER TABLE `shop`.`product_categories` ADD CONSTRAINT `fk_product_categories_category_id_categories` FOREIGN KEY (`category_id`) REFERENCES `shop`.`categories` (`category_id`)",
    "ALTER TABLE `shop`.`product_categories` ADD CONSTRAINT `fk_product_categories_product_id_products` FOREIGN KEY (`product_id`) REFERENCES `shop`.`products` (`product_id`)",
    "ALTER TABLE `shop`.`products` ADD CONSTRAINT `fk_products_primary_category` FOREIGN KEY (`primary_category_id`) REFERENCES `shop`.`categories` (`category_id`) ON DELETE SET NULL",
  ]);
});

test("creates deterministic migration checksums", () => {
  const schemas = discoverEntitySchemas(makeMigrationFixture(), ["src/**/*.entity.ts"]);
  const reordered = schemas.map((schema) => ({
    ...schema,
    columns: [...schema.columns].reverse(),
    indexes: [...schema.indexes].reverse(),
    relations: [...schema.relations].reverse(),
  }));

  assert.equal(
    createMigrationChecksum("postgresql", schemas),
    createMigrationChecksum("postgresql", reordered.reverse()),
  );
  assert.notEqual(
    createMigrationChecksum("postgresql", schemas),
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

  assert.deepEqual(await loadNPAMigrationConfig({ cwd: root }), {
    adapter: "postgresql",
    url: "postgresql://localhost/db",
    entities: ["models/**/*.entity.ts"],
    migrations: { dir: "database/migrations", table: "custom_migrations" },
  });

  assert.deepEqual(
    await loadNPAMigrationConfig({
      cwd: root,
      adapter: "mysql",
      url: "mysql://localhost/db",
      entities: ["src/**/*.entity.ts"],
    }),
    {
      adapter: "mysql",
      url: "mysql://localhost/db",
      entities: ["src/**/*.entity.ts"],
      migrations: { dir: "database/migrations", table: "custom_migrations" },
    },
  );
});

test("writes and loads migration SQL files deterministically", () => {
  const root = makeTempRoot();
  const statements = [
    "CREATE TABLE products (id INT PRIMARY KEY)",
    "ALTER TABLE products ADD COLUMN name TEXT",
  ];
  const migration = writeMigrationFile(root, "npa/migrations", "Init Products", statements);

  assert.match(migration.name, /^\d{14}_init_products$/);
  assert.equal(path.basename(migration.filePath), "migration.sql");
  assert.equal(migration.statementCount, 2);
  assert.equal(
    fs.readFileSync(migration.filePath, "utf8"),
    `${statements[0]};\n\n${statements[1]};\n`,
  );
  assert.equal(
    migration.checksum,
    createMigrationChecksumFromSql(formatMigrationSql(statements)),
  );
  assert.deepEqual(loadMigrationFiles(root, "npa/migrations"), [migration]);
});

function makeMigrationFixture() {
  const root = makeTempRoot();
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, "product.entity.ts"),
    `
import { Column, Entity, Id, Index, ManyToMany, ManyToOne, Unique, Version } from "@npa/test";

@Index({ name: "idx_products_active_created_at", columns: ["active", "createdAt"] })
@Entity({ name: "products", schema: "shop" })
export class Product {
  @Id({ name: "product_id" })
  id?: number;

  @Unique({ name: "uidx_products_name" })
  @Column({ name: "product_name", type: "VARCHAR(80)" })
  name!: string;

  @Column({ nullable: true })
  description?: string | null;

  @Column({ index: "idx_products_active" })
  active!: boolean;

  @Column({ name: "created_at" })
  createdAt!: Date;

  @Version({ name: "lock_version" })
  version!: number;

  @ManyToOne(() => Category, { joinColumn: "primary_category_id", foreignKeyName: "fk_products_primary_category", onDelete: "SET NULL" })
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

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "npa-migration-"));
}
