import { describe, expect, test } from "@jest/globals";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertRepositoryContract,
  createProductEntity,
  databaseAdapters,
  startContainerOrSkip,
  uniqueTableName,
} from "./database-flow";

describe("migration E2E", () => {
  test("reports migration CLI config errors", () => {
    const root = makeMigrationProject({
      adapter: "postgresql",
      tableName: "products",
      categoryTableName: "categories",
      joinTableName: "product_categories",
      statusIndexName: "idx_products_status",
      skuUniqueIndexName: "uidx_products_sku",
      url: "postgresql://localhost/npa",
    });

    const missingConfig = runCli(
      ["db", "push", "--dry-run", "--config", "missing.config.mjs"],
      root,
    );
    expect(missingConfig.status).toEqual(1);
    expect(missingConfig.stderr).toMatch(/NPA config file was not found/);

    writeConfig(root, {
      adapter: "sqlite",
      url: "sqlite://local.db",
    });
    const badAdapter = runCli(
      ["db", "push", "--dry-run", "--config", "npa.config.mjs"],
      root,
    );
    expect(badAdapter.status).toEqual(1);
    expect(badAdapter.stderr).toMatch(
      /Migration adapter must be postgresql or mysql/,
    );

    writeConfig(root, {
      url: "sqlite://local.db",
    });
    const badUrl = runCli(
      ["db", "push", "--dry-run", "--config", "npa.config.mjs"],
      root,
    );
    expect(badUrl.status).toEqual(1);
    expect(badUrl.stderr).toMatch(
      /Migration url must start with postgres:\/\/, postgresql:\/\/, or mysql:\/\//,
    );

    writeConfig(root, {
      adapter: "postgresql",
      url: "mysql://localhost/npa",
    });
    const mismatchedUrl = runCli(
      ["db", "push", "--dry-run", "--config", "npa.config.mjs"],
      root,
    );
    expect(mismatchedUrl.status).toEqual(1);
    expect(mismatchedUrl.stderr).toMatch(
      /Migration adapter postgresql does not match mysql url/,
    );
  });

  for (const adapter of databaseAdapters) {
    test(`runs npa db push against ${adapter.name} and alters existing schema`, async () => {
      const tableName = uniqueTableName(`${adapter.tablePrefix}_migration`);
      const categoryTableName = uniqueTableName(
        `${adapter.tablePrefix}_category`,
      );
      const joinTableName = uniqueTableName(`${adapter.tablePrefix}_join`);
      const statusIndexName = uniqueTableName(
        `${adapter.tablePrefix}_status_idx`,
      );
      const skuUniqueIndexName = uniqueTableName(
        `${adapter.tablePrefix}_sku_uidx`,
      );
      const container = await startContainerOrSkip(adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      try {
        const root = makeMigrationProject({
          adapter: adapter.adapterName,
          tableName,
          categoryTableName,
          joinTableName,
          statusIndexName,
          skuUniqueIndexName,
          url: container.getConnectionUri(),
        });

        const first = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expect(first.status).toEqual(0);
        expect(first.stdout).toMatch(/Pushed database schema/);

        const second = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expect(second.status).toEqual(0);
        expect(second.stdout).toMatch(/Database schema is up to date/);

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
        const altered = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expect(altered.status).toEqual(0);
        expect(altered.stdout).toMatch(/Pushed database schema/);

        const productColumns = await readColumnNames(
          adapter,
          queryable,
          tableName,
        );
        expect(productColumns.includes("sku")).toEqual(true);
        expect(productColumns.includes("legacy_code")).toEqual(false);

        expect(
          (await readColumnNames(adapter, queryable, joinTableName)).sort(),
        ).toEqual(["category_id", "product_id"]);

        const indexes = await readIndexes(adapter, queryable, tableName);
        expect(indexes.get(statusIndexName)).toEqual({ unique: false });
        expect(indexes.get(skuUniqueIndexName)).toEqual({ unique: true });

        const foreignKeys = await readForeignKeys(
          adapter,
          queryable,
          joinTableName,
        );
        expect(foreignKeys.get("category_id")).toEqual({
          targetTable: categoryTableName,
          targetColumn: "category_id",
        });
        expect(foreignKeys.get("product_id")).toEqual({
          targetTable: tableName,
          targetColumn: "product_id",
        });

        const third = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expect(third.status).toEqual(0);
        expect(third.stdout).toMatch(/Database schema is up to date/);
      } finally {
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
      }
    }, 240_000);
  }

  for (const adapter of databaseAdapters) {
    test(`runs npa migrate dev and deploy against ${adapter.name}`, async () => {
      const tableName = uniqueTableName(`${adapter.tablePrefix}_migrate_file`);
      const categoryTableName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_category`,
      );
      const joinTableName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_join`,
      );
      const auditTableName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_audit`,
      );
      const statusIndexName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_status_idx`,
      );
      const skuUniqueIndexName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_sku_uidx`,
      );
      const container = await startContainerOrSkip(adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      try {
        const root = makeMigrationProject({
          adapter: adapter.adapterName,
          tableName,
          categoryTableName,
          joinTableName,
          statusIndexName,
          skuUniqueIndexName,
          url: container.getConnectionUri(),
        });

        const created = runCli(
          ["migrate", "dev", "--name", "init", "--config", "npa.config.mjs"],
          root,
        );
        expect(created.status).toEqual(0);
        expect(created.stdout).toMatch(
          /Created and applied migration \d{14}_init/,
        );

        const migrationRoot = path.join(root, "npa", "migrations");
        const migrationDirs = fs.readdirSync(migrationRoot).sort();
        expect(migrationDirs.length).toEqual(1);
        expect(migrationDirs[0]).toMatch(/^\d{14}_init$/);
        expect(
          fs.existsSync(
            path.join(migrationRoot, migrationDirs[0], "migration.sql"),
          ),
        ).toEqual(true);
        const migrationFilePath = path.join(
          migrationRoot,
          migrationDirs[0],
          "migration.sql",
        );

        const deploy = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(deploy.status).toEqual(0);
        expect(deploy.stdout).toMatch(/No pending migrations/);

        const migrationSql = fs.readFileSync(migrationFilePath, "utf8");
        fs.appendFileSync(migrationFilePath, "\n-- tampered\n", "utf8");
        const tampered = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(tampered.status).not.toEqual(0);
        expect(tampered.stderr).toMatch(/checksum mismatch/);
        fs.writeFileSync(migrationFilePath, migrationSql, "utf8");

        const restored = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(restored.status).toEqual(0);
        expect(restored.stdout).toMatch(/No pending migrations/);

        const emptyCreateOnly = runCli(
          [
            "migrate",
            "dev",
            "--name",
            "empty",
            "--create-only",
            "--config",
            "npa.config.mjs",
          ],
          root,
        );
        expect(emptyCreateOnly.status).toEqual(0);
        expect(emptyCreateOnly.stdout).toMatch(/No schema changes found/);
        expect(fs.readdirSync(migrationRoot).sort()).toEqual(migrationDirs);

        queryable = await adapter.createQueryable(container);
        const repository = adapter.createRepository({
          entity: createProductEntity(tableName),
          queryable,
        });
        await assertRepositoryContract(repository);

        writePendingMigration(root, "99999999999991_create_audit", [
          createAuditTableSql(adapter, auditTableName),
        ]);
        writePendingMigration(root, "99999999999992_add_audit_reviewed", [
          addAuditReviewedColumnSql(adapter, auditTableName),
        ]);

        const pendingPreview = runCli(
          ["migrate", "deploy", "--dry-run", "--config", "npa.config.mjs"],
          root,
        );
        expect(pendingPreview.status).toEqual(0);
        expect(pendingPreview.stdout).toMatch(/Pending migrations: 2/);
        expect(
          pendingPreview.stdout.indexOf("99999999999991_create_audit") <
            pendingPreview.stdout.indexOf("99999999999992_add_audit_reviewed"),
        ).toEqual(true);

        const pendingDeploy = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(pendingDeploy.status).toEqual(0);
        expect(pendingDeploy.stdout).toMatch(/Applied 2 migration\(s\)/);
        expect(
          await readColumnNames(adapter, queryable, auditTableName),
        ).toEqual(["audit_id", "message", "reviewed"]);

        const redeploy = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(redeploy.status).toEqual(0);
        expect(redeploy.stdout).toMatch(/No pending migrations \(3 checked\)/);
      } finally {
        try {
          if (queryable) {
            for (const table of [
              auditTableName,
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
      }
    }, 240_000);
  }
});

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

function writeConfig(root, config) {
  fs.writeFileSync(
    path.join(root, "npa.config.mjs"),
    `export default ${JSON.stringify(config, null, 2)};`,
    "utf8",
  );
}

function writeProductEntity(root, options) {
  fs.writeFileSync(
    path.join(root, "src", "product.entity.ts"),
    `
import { Column, Entity, Id, Version${options.withRelations ? ", Index, ManyToMany, Unique" : ""} } from "@node-persistence-api/core";

@Entity({ name: ${JSON.stringify(options.tableName)} })
export class Product {
  @Id({ name: "product_id" })
  id?: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;

  @Column(${options.withRelations ? "{ default: true }" : ""})
  active!: boolean;

  ${options.withRelations ? "@Index({ name: " + JSON.stringify(options.statusIndexName) + " })\n  " : ""}@Column()
  status!: string;

  @Column({ name: "created_at" })
  createdAt!: Date;

  @Version()
  version!: number;
${options.withRelations ? "\n  @Unique({ name: " + JSON.stringify(options.skuUniqueIndexName) + " })\n  @Column({ nullable: true })\n  sku?: string | null;\n\n  @ManyToMany(() => Category, { joinTable: " + JSON.stringify(options.joinTableName) + " })\n  categories?: Category[];\n" : '\n  @Column({ name: "legacy_code", nullable: true })\n  legacyCode?: string | null;\n'}}
${
  options.withRelations
    ? `
@Entity({ name: ${JSON.stringify(options.categoryTableName)} })
export class Category {
  @Id({ name: "category_id" })
  id?: number;

  @Column()
  label!: string;
}
`
    : ""
}
`,
    "utf8",
  );
}

function writePendingMigration(root, name, statements) {
  const migrationRoot = path.join(root, "npa", "migrations", name);
  fs.mkdirSync(migrationRoot, { recursive: true });
  fs.writeFileSync(
    path.join(migrationRoot, "migration.sql"),
    `${statements.map((statement) => statement.trim()).join(";\n\n")};\n`,
    "utf8",
  );
}

function createAuditTableSql(adapter, tableName) {
  const table = adapter.quoteIdentifier(tableName);

  if (adapter.adapterName === "mysql") {
    return `
      CREATE TABLE ${table} (
        audit_id INT AUTO_INCREMENT PRIMARY KEY,
        message VARCHAR(255) NOT NULL
      )
    `;
  }

  return `
    CREATE TABLE ${table} (
      audit_id SERIAL PRIMARY KEY,
      message TEXT NOT NULL
    )
  `;
}

function addAuditReviewedColumnSql(adapter, tableName) {
  return `
    ALTER TABLE ${adapter.quoteIdentifier(tableName)}
    ADD COLUMN reviewed BOOLEAN NOT NULL DEFAULT FALSE
  `;
}

async function readColumnNames(adapter, queryable, tableName) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
          'SELECT column_name AS "columnName"',
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
          'SELECT i.relname AS "indexName", ix.indisunique AS "unique"',
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
      unique:
        adapter.adapterName === "postgresql"
          ? row.unique === true
          : Number(row.nonUnique) === 0,
    });
  }

  return indexes;
}

async function readForeignKeys(adapter, queryable, tableName) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
          'SELECT kcu.column_name AS "columnName",',
          '  ccu.table_name AS "targetTable",',
          '  ccu.column_name AS "targetColumn"',
          "FROM information_schema.table_constraints tc",
          "JOIN information_schema.key_column_usage kcu",
          "  ON tc.constraint_name = kcu.constraint_name",
          "  AND tc.table_schema = kcu.table_schema",
          "JOIN information_schema.constraint_column_usage ccu",
          "  ON ccu.constraint_name = tc.constraint_name",
          "  AND ccu.constraint_schema = tc.constraint_schema",
          "WHERE tc.constraint_type = 'FOREIGN KEY'",
          "  AND tc.table_schema = 'public'",
          "  AND tc.table_name = $1",
          "ORDER BY kcu.column_name",
        ].join("\n")
      : [
          "SELECT COLUMN_NAME AS columnName,",
          "  REFERENCED_TABLE_NAME AS targetTable,",
          "  REFERENCED_COLUMN_NAME AS targetColumn",
          "FROM information_schema.KEY_COLUMN_USAGE",
          "WHERE TABLE_SCHEMA = DATABASE()",
          "  AND TABLE_NAME = ?",
          "  AND REFERENCED_TABLE_NAME IS NOT NULL",
          "ORDER BY COLUMN_NAME",
        ].join("\n"),
    [tableName],
  );
  const foreignKeys = new Map();

  for (const row of rows) {
    foreignKeys.set(row.columnName, {
      targetTable: row.targetTable,
      targetColumn: row.targetColumn,
    });
  }

  return foreignKeys;
}

async function queryRows(queryable, sql, values) {
  const result = await queryable.query(sql, values);

  if (Array.isArray(result)) {
    return Array.isArray(result[0]) ? result[0] : [];
  }

  return result.rows;
}
