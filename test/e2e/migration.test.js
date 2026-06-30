const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertRepositoryContract,
  createProductEntity,
  databaseAdapters,
  startContainerOrSkip,
  uniqueTableName,
} = require("./database-flow");

for (const adapter of databaseAdapters) {
  test(
    `runs npa migrate against ${adapter.name} and alters existing schema`,
    async (t) => {
      const tableName = uniqueTableName(`${adapter.tablePrefix}_migration`);
      const categoryTableName = uniqueTableName(`${adapter.tablePrefix}_category`);
      const joinTableName = uniqueTableName(`${adapter.tablePrefix}_join`);
      const statusIndexName = uniqueTableName(`${adapter.tablePrefix}_status_idx`);
      const skuUniqueIndexName = uniqueTableName(`${adapter.tablePrefix}_sku_uidx`);
      const container = await startContainerOrSkip(t, adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      t.after(async () => {
        try {
          if (queryable) {
            for (const table of [
              joinTableName,
              categoryTableName,
              tableName,
              "_npa_migrations",
            ]) {
              await adapter.executeSql(
                queryable,
                `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(table)}`,
              );
            }
          }
        } finally {
          if (queryable) {
            await adapter.closeQueryable(queryable);
          }
          await container.stop();
        }
      });

      const root = makeMigrationProject({
        adapter: adapter.adapterName,
        tableName,
        categoryTableName,
        joinTableName,
        statusIndexName,
        skuUniqueIndexName,
        url: container.getConnectionUri(),
      });

      const first = runCli(["migrate", "--config", "npa.config.mjs"], root);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /Applied migration schema/);

      const second = runCli(["migrate", "--config", "npa.config.mjs"], root);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /Database schema is up to date/);

      queryable = await adapter.createQueryable(container);
      const repository = adapter.createRepository({
        entity: createProductEntity(tableName),
        queryable,
      });
      await assertRepositoryContract(repository);

      writeProductEntity(root, {
        tableName,
        categoryTableName,
        joinTableName,
        statusIndexName,
        skuUniqueIndexName,
        withRelations: true,
      });
      const altered = runCli(["migrate", "--config", "npa.config.mjs"], root);
      assert.equal(altered.status, 0, altered.stderr);
      assert.match(altered.stdout, /Applied migration schema/);

      const productColumns = await readColumnNames(adapter, queryable, tableName);
      assert.equal(productColumns.includes("sku"), true);
      assert.equal(productColumns.includes("legacy_code"), false);

      assert.deepEqual(
        (await readColumnNames(adapter, queryable, joinTableName)).sort(),
        ["category_id", "product_id"],
      );

      const indexes = await readIndexes(adapter, queryable, tableName);
      assert.deepEqual(indexes.get(statusIndexName), { unique: false });
      assert.deepEqual(indexes.get(skuUniqueIndexName), { unique: true });

      const third = runCli(["migrate", "--config", "npa.config.mjs"], root);
      assert.equal(third.status, 0, third.stderr);
      assert.match(third.stdout, /Database schema is up to date/);

      await assertRepositoryContract(repository);
    },
  );
}

function runCli(args, cwd) {
  return childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, "..", "..", "dist", "cli", "npa.js"), ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

function makeMigrationProject(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npa-migrate-e2e-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "npa.config.mjs"),
    `export default {
      adapter: ${JSON.stringify(options.adapter)},
      url: ${JSON.stringify(options.url)},
      entities: ["src/**/*.entity.ts"]
    };`,
    "utf8",
  );
  writeProductEntity(root, options);
  return root;
}

function writeProductEntity(root, options) {
  fs.writeFileSync(
    path.join(root, "src", "product.entity.ts"),
    `
import { Column, Entity, Id${options.withRelations ? ", Index, ManyToMany, Unique" : ""} } from "@honeybeaers/npa";

@Entity({ name: ${JSON.stringify(options.tableName)} })
export class Product {
  @Id({ name: "product_id" })
  id?: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;

  @Column()
  active!: boolean;

  ${options.withRelations ? "@Index({ name: " + JSON.stringify(options.statusIndexName) + " })\n  " : ""}@Column()
  status!: string;

  @Column({ name: "created_at" })
  createdAt!: Date;
${options.withRelations ? "\n  @Unique({ name: " + JSON.stringify(options.skuUniqueIndexName) + " })\n  @Column({ nullable: true })\n  sku?: string | null;\n\n  @ManyToMany(() => Category, { joinTable: " + JSON.stringify(options.joinTableName) + " })\n  categories?: Category[];\n" : "\n  @Column({ name: \"legacy_code\", nullable: true })\n  legacyCode?: string | null;\n"}}
${options.withRelations ? `
@Entity({ name: ${JSON.stringify(options.categoryTableName)} })
export class Category {
  @Id({ name: "category_id" })
  id?: number;

  @Column()
  label!: string;
}
` : ""}
`,
    "utf8",
  );
}

async function readColumnNames(adapter, queryable, tableName) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
        "SELECT column_name AS \"columnName\"",
        "FROM information_schema.columns",
        "WHERE table_schema = 'public' AND table_name = $1",
        "ORDER BY ordinal_position",
      ].join("\n")
      : [
        "SELECT COLUMN_NAME AS columnName",
        "FROM information_schema.columns",
        "WHERE table_schema = DATABASE() AND table_name = ?",
        "ORDER BY ORDINAL_POSITION",
      ].join("\n"),
    [tableName],
  );

  return rows.map((row) => row.columnName);
}


async function readIndexes(adapter, queryable, tableName) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
        "SELECT i.relname AS \"indexName\", ix.indisunique AS \"unique\"",
        "FROM pg_class t",
        "JOIN pg_namespace n ON n.oid = t.relnamespace",
        "JOIN pg_index ix ON ix.indrelid = t.oid",
        "JOIN pg_class i ON i.oid = ix.indexrelid",
        "WHERE n.nspname = 'public' AND t.relname = $1",
      ].join("\n")
      : [
        "SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique",
        "FROM information_schema.statistics",
        "WHERE table_schema = DATABASE() AND table_name = ?",
        "GROUP BY INDEX_NAME, NON_UNIQUE",
      ].join("\n"),
    [tableName],
  );
  const indexes = new Map();

  for (const row of rows) {
    indexes.set(row.indexName, {
      unique: adapter.adapterName === "postgresql"
        ? row.unique === true
        : Number(row.nonUnique) === 0,
    });
  }

  return indexes;
}

async function queryRows(queryable, sql, values) {
  const result = await queryable.query(sql, values);

  if (Array.isArray(result)) {
    return Array.isArray(result[0]) ? result[0] : [];
  }

  return result.rows;
}
