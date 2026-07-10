import { describe, expect, test } from "@jest/globals";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foreignKeyName } from "../../src/migration/helpers";
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
        expectCliSuccess(first);
        expect(first.stdout).toMatch(/Pushed database schema/);

        const second = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(second);
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
        const blockedAlter = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expect(blockedAlter.status).not.toEqual(0);
        expect(blockedAlter.stderr).toMatch(/--allow-destructive/);

        const altered = runCli(
          [
            "db",
            "push",
            "--allow-destructive",
            "--config",
            "npa.config.mjs",
          ],
          root,
        );
        expectCliSuccess(altered);
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
        expectCliSuccess(third);
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

    test(`applies string-check and native enum migrations against ${adapter.name}`, async () => {
      const tableName = uniqueTableName(`${adapter.tablePrefix}_enum`);
      const roleTypeName = uniqueTableName(`${adapter.tablePrefix}_role_enum`);
      const container = await startContainerOrSkip(adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      try {
        const root = makeEnumMigrationProject({
          adapter: adapter.adapterName,
          tableName,
          roleTypeName,
          url: container.getConnectionUri(),
        });

        const pushed = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(pushed);

        queryable = await adapter.createQueryable(container);
        const tagsValue = adapter.adapterName === "postgresql"
          ? "ARRAY['fragile', 'new']"
          : "JSON_ARRAY('fragile', 'new')";
        const scoresValue = adapter.adapterName === "postgresql"
          ? "ARRAY[1, 2]"
          : "JSON_ARRAY(1, 2)";
        await adapter.executeSql(
          queryable,
          [
            `INSERT INTO ${adapter.quoteIdentifier(tableName)}`,
            `(${adapter.quoteIdentifier("status")}, ${adapter.quoteIdentifier("role")}, ${adapter.quoteIdentifier("priority")}, ${adapter.quoteIdentifier("tags")}, ${adapter.quoteIdentifier("scores")})`,
            `VALUES ('ACTIVE', 'ADMIN', 1, ${tagsValue}, ${scoresValue})`,
          ].join(" "),
        );
        await expect(adapter.executeSql(
          queryable,
          [
            `INSERT INTO ${adapter.quoteIdentifier(tableName)}`,
            `(${adapter.quoteIdentifier("status")}, ${adapter.quoteIdentifier("role")}, ${adapter.quoteIdentifier("priority")}, ${adapter.quoteIdentifier("tags")}, ${adapter.quoteIdentifier("scores")})`,
            `VALUES ('DELETED', 'ADMIN', 1, ${tagsValue}, ${scoresValue})`,
          ].join(" "),
        )).rejects.toThrow();
        await expect(adapter.executeSql(
          queryable,
          [
            `INSERT INTO ${adapter.quoteIdentifier(tableName)}`,
            `(${adapter.quoteIdentifier("status")}, ${adapter.quoteIdentifier("role")}, ${adapter.quoteIdentifier("priority")}, ${adapter.quoteIdentifier("tags")}, ${adapter.quoteIdentifier("scores")})`,
            `VALUES ('ACTIVE', 'ADMIN', 9, ${tagsValue}, ${scoresValue})`,
          ].join(" "),
        )).rejects.toThrow();

        const roleType = await readColumnDbType(
          adapter,
          queryable,
          tableName,
          "role",
        );
        const priorityType = await readColumnDbType(
          adapter,
          queryable,
          tableName,
          "priority",
        );
        const tagsType = await readColumnDbType(
          adapter,
          queryable,
          tableName,
          "tags",
        );
        const scoresType = await readColumnDbType(
          adapter,
          queryable,
          tableName,
          "scores",
        );

        if (adapter.adapterName === "postgresql") {
          expect(roleType).toEqual(roleTypeName);
          expect(priorityType).toEqual("integer");
          expect(tagsType).toEqual("_text");
          expect(scoresType).toEqual("_int4");
        } else {
          expect(roleType).toMatch(/^enum\('ADMIN','USER'\)$/i);
          expect(priorityType).toEqual("int");
          expect(tagsType).toEqual("json");
          expect(scoresType).toEqual("json");
        }
      } finally {
        try {
          if (queryable) {
            await adapter.executeSql(
              queryable,
              `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(tableName)}`,
            );
            if (adapter.adapterName === "postgresql") {
              await adapter.executeSql(
                queryable,
                `DROP TYPE IF EXISTS ${adapter.quoteIdentifier(roleTypeName)}`,
              );
            }
            await adapter.executeSql(
              queryable,
              `DROP TABLE IF EXISTS ${adapter.quoteIdentifier("_npa_migrations")}`,
            );
          }
        } finally {
          if (queryable) {
            await adapter.closeQueryable(queryable);
          }
          await container.stop();
        }
      }
    }, 240_000);

    test(`renames columns and guards migration history drift for ${adapter.name}`, async () => {
      const tableName = uniqueTableName(`${adapter.tablePrefix}_rename`);
      const categoryTableName = uniqueTableName(
        `${adapter.tablePrefix}_rename_category`,
      );
      const joinTableName = uniqueTableName(`${adapter.tablePrefix}_rename_join`);
      const auditTableName = uniqueTableName(`${adapter.tablePrefix}_drift_audit`);
      const statusIndexName = uniqueTableName(
        `${adapter.tablePrefix}_rename_status_idx`,
      );
      const skuUniqueIndexName = uniqueTableName(
        `${adapter.tablePrefix}_rename_sku_uidx`,
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
        expectCliSuccess(first);

        writeRenamedProductEntity(root, { tableName });
        const renamed = runCli(
          [
            "db",
            "push",
            "--rename",
            `column:${tableName}.legacy_code=external_code`,
            "--config",
            "npa.config.mjs",
          ],
          root,
        );
        expectCliSuccess(renamed);
        expect(renamed.stdout).toMatch(/Pushed database schema/);

        queryable = await adapter.createQueryable(container);
        const productColumns = await readColumnNames(
          adapter,
          queryable,
          tableName,
        );
        expect(productColumns.includes("external_code")).toEqual(true);
        expect(productColumns.includes("legacy_code")).toEqual(false);

        await adapter.executeSql(
          queryable,
          insertMigrationHistorySql(
            adapter,
            "99999999999990_remote_only",
          ),
        );
        writePendingMigration(root, "npa/migrations", "99999999999991_create_audit", [
          createAuditTableSql(adapter, auditTableName),
        ]);

        const drift = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(drift.status).not.toEqual(0);
        expect(drift.stderr).toMatch(/Migration history drift detected/);

        const allowed = runCli(
          ["migrate", "deploy", "--allow-drift", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(allowed);
        expect(allowed.stdout).toMatch(/Applied 1 migration\(s\)/);
        expect(await readColumnNames(adapter, queryable, auditTableName)).toEqual([
          "audit_id",
          "message",
        ]);
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
      const migrationsDir = "database/changes";
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
          migrationsDir,
          url: container.getConnectionUri(),
          withRelations: true,
        });

        const created = runCli(
          ["migrate", "dev", "--name", "init", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(created);
        expect(created.stdout).toMatch(
          /Created and applied migration \d{14}_init/,
        );

        const migrationRoot = path.join(root, migrationsDir);
        const migrationDirs = fs.readdirSync(migrationRoot).sort();
        expect(migrationDirs.length).toEqual(1);
        expect(migrationDirs[0]).toMatch(/^\d{14}_init$/);
        expect(
          fs.existsSync(
            path.join(migrationRoot, migrationDirs[0], "migration.sql"),
          ),
        ).toEqual(true);
        expect(
          fs.existsSync(
            path.join(migrationRoot, migrationDirs[0], "down.sql"),
          ),
        ).toEqual(true);
        const migrationFilePath = path.join(
          migrationRoot,
          migrationDirs[0],
          "migration.sql",
        );
        const downSql = fs.readFileSync(
          path.join(migrationRoot, migrationDirs[0], "down.sql"),
          "utf8",
        );
        expect(downSql).toContain(
          `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(joinTableName)};`,
        );
        expect(downSql).toContain(
          `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(categoryTableName)};`,
        );
        expect(downSql).toContain(
          `DROP TABLE IF EXISTS ${adapter.quoteIdentifier(tableName)};`,
        );

        const deploy = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(deploy);
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
        expectCliSuccess(restored);
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
        expectCliSuccess(emptyCreateOnly);
        expect(emptyCreateOnly.stdout).toMatch(/No schema changes found/);
        expect(fs.readdirSync(migrationRoot).sort()).toEqual(migrationDirs);

        queryable = await adapter.createQueryable(container);
        const repository = adapter.createRepository({
          entity: createProductEntity(tableName),
          queryable,
        });
        await assertRepositoryContract(repository);

        writePendingMigration(root, migrationsDir, "99999999999991_create_audit", [
          createAuditTableSql(adapter, auditTableName),
        ]);
        writePendingMigration(root, migrationsDir, "99999999999992_add_audit_reviewed", [
          addAuditReviewedColumnSql(adapter, auditTableName),
        ]);

        const pendingPreview = runCli(
          ["migrate", "deploy", "--dry-run", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(pendingPreview);
        expect(pendingPreview.stdout).toMatch(/Pending migrations: 2/);
        expect(
          pendingPreview.stdout.indexOf("99999999999991_create_audit") <
            pendingPreview.stdout.indexOf("99999999999992_add_audit_reviewed"),
        ).toEqual(true);

        const pendingDeploy = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(pendingDeploy);
        expect(pendingDeploy.stdout).toMatch(/Applied 2 migration\(s\)/);
        expect(
          await readColumnNames(adapter, queryable, auditTableName),
        ).toEqual(["audit_id", "message", "reviewed"]);
        expect(await readMigrationHistory(adapter, queryable, migrationDirs[0])).toEqual(
          expect.objectContaining({
            name: migrationDirs[0],
            status: "applied",
            statementCount: expect.any(Number),
            errorMessage: null,
          }),
        );
        expect(
          await readMigrationHistory(
            adapter,
            queryable,
            "99999999999991_create_audit",
          ),
        ).toEqual(expect.objectContaining({
          name: "99999999999991_create_audit",
          status: "applied",
          statementCount: 1,
          errorMessage: null,
        }));
        expect(
          await readMigrationHistory(
            adapter,
            queryable,
            "99999999999992_add_audit_reviewed",
          ),
        ).toEqual(expect.objectContaining({
          name: "99999999999992_add_audit_reviewed",
          status: "applied",
          statementCount: 1,
          errorMessage: null,
        }));

        const redeploy = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(redeploy);
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

  for (const adapter of databaseAdapters) {
    test(`plans indexed no-op and nullable diffs with migrate dev against ${adapter.name}`, async () => {
      const tableName = uniqueTableName(`${adapter.tablePrefix}_migrate_diff`);
      const categoryTableName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_diff_category`,
      );
      const joinTableName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_diff_join`,
      );
      const statusIndexName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_diff_status_idx`,
      );
      const skuUniqueIndexName = uniqueTableName(
        `${adapter.tablePrefix}_migrate_diff_sku_uidx`,
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
          withRelations: true,
        });

        const pushed = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(pushed);

        const indexedNoop = runCli(
          ["migrate", "dev", "--dry-run", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(indexedNoop);
        expect(indexedNoop.stdout).toMatch(/Statements: 0/);
        expect(indexedNoop.stderr).not.toMatch(/join is not a function/);

        queryable = await adapter.createQueryable(container);
        const foreignKey = foreignKeyName(
          joinTableName,
          ["category_id"],
          categoryTableName,
          adapter.adapterName === "postgresql" ? 63 : 64,
        );
        const dropForeignKey = adapter.adapterName === "postgresql"
          ? `ALTER TABLE ${adapter.quoteIdentifier(joinTableName)} DROP CONSTRAINT ${adapter.quoteIdentifier(foreignKey)}`
          : `ALTER TABLE ${adapter.quoteIdentifier(joinTableName)} DROP FOREIGN KEY ${adapter.quoteIdentifier(foreignKey)}`;
        const addForeignKey = (onDelete = "") =>
          `ALTER TABLE ${adapter.quoteIdentifier(joinTableName)} ADD CONSTRAINT ${adapter.quoteIdentifier(foreignKey)} FOREIGN KEY (${adapter.quoteIdentifier("category_id")}) REFERENCES ${adapter.quoteIdentifier(categoryTableName)} (${adapter.quoteIdentifier("category_id")})${onDelete}`;

        await adapter.executeSql(queryable, dropForeignKey);
        await adapter.executeSql(
          queryable,
          addForeignKey(" ON DELETE CASCADE"),
        );

        const changedForeignKey = runCli(
          ["migrate", "dev", "--dry-run", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(changedForeignKey);
        expect(changedForeignKey.stdout).toMatch(/Statements: 2/);
        expect(changedForeignKey.stdout).toContain(dropForeignKey);

        await adapter.executeSql(queryable, dropForeignKey);
        await adapter.executeSql(queryable, addForeignKey());

        writeProductEntity(root, {
          tableName,
          categoryTableName,
          joinTableName,
          statusIndexName,
          skuUniqueIndexName,
          withRelations: true,
          statusNullable: true,
        });

        const nullablePreview = runCli(
          [
            "migrate",
            "dev",
            "--dry-run",
            "--name",
            "nullable_status",
            "--config",
            "npa.config.mjs",
          ],
          root,
        );
        expectCliSuccess(nullablePreview);
        expect(nullablePreview.stdout).toMatch(/Statements: 1/);
        expect(nullablePreview.stdout).toMatch(
          adapter.adapterName === "postgresql"
            ? /ALTER TABLE .* ALTER COLUMN .*status.* DROP NOT NULL/
            : /ALTER TABLE .* MODIFY COLUMN .*status/,
        );

        const nullableMigration = runCli(
          [
            "migrate",
            "dev",
            "--name",
            "nullable_status",
            "--allow-destructive",
            "--config",
            "npa.config.mjs",
          ],
          root,
        );
        expectCliSuccess(nullableMigration);
        expect(nullableMigration.stdout).toMatch(
          /Created and applied migration \d{14}_nullable_status/,
        );

        expect(
          await readColumnNullable(adapter, queryable, tableName, "status"),
        ).toEqual(true);

        const finalNoop = runCli(
          ["migrate", "dev", "--dry-run", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(finalNoop);
        expect(finalNoop.stdout).toMatch(/Statements: 0/);
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

    test(`records failed migration attempts for ${adapter.name}`, async () => {
      const missingTableName = uniqueTableName(`${adapter.tablePrefix}_missing`);
      const migrationName = "99999999999992_failed_attempt";
      const container = await startContainerOrSkip(adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      try {
        const root = makeMigrationProject({
          adapter: adapter.adapterName,
          tableName: uniqueTableName(`${adapter.tablePrefix}_failed_product`),
          categoryTableName: uniqueTableName(`${adapter.tablePrefix}_failed_category`),
          joinTableName: uniqueTableName(`${adapter.tablePrefix}_failed_join`),
          statusIndexName: uniqueTableName(`${adapter.tablePrefix}_failed_status_idx`),
          skuUniqueIndexName: uniqueTableName(`${adapter.tablePrefix}_failed_sku_uidx`),
          url: container.getConnectionUri(),
        });
        writePendingMigration(root, "npa/migrations", migrationName, [
          `ALTER TABLE ${adapter.quoteIdentifier(missingTableName)} ADD COLUMN broken INTEGER`,
        ]);

        const failed = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(failed.status).not.toEqual(0);

        queryable = await adapter.createQueryable(container);
        const history = await readMigrationHistory(adapter, queryable, migrationName);
        expect(history).toEqual(expect.objectContaining({
          name: migrationName,
          status: "failed",
        }));
      } finally {
        try {
          if (queryable) {
            await adapter.executeSql(
              queryable,
              `DROP TABLE IF EXISTS ${adapter.quoteIdentifier("_npa_migrations")}`,
            );
          }
        } finally {
          if (queryable) {
            await adapter.closeQueryable(queryable);
          }
          await container.stop();
        }
      }
    }, 240_000);

    test(`retries failed migration attempts for ${adapter.name}`, async () => {
      const auditTableName = uniqueTableName(`${adapter.tablePrefix}_retry_audit`);
      const missingTableName = uniqueTableName(`${adapter.tablePrefix}_retry_missing`);
      const migrationName = "99999999999993_retry_attempt";
      const container = await startContainerOrSkip(adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      try {
        const root = makeMigrationProject({
          adapter: adapter.adapterName,
          tableName: uniqueTableName(`${adapter.tablePrefix}_retry_product`),
          categoryTableName: uniqueTableName(`${adapter.tablePrefix}_retry_category`),
          joinTableName: uniqueTableName(`${adapter.tablePrefix}_retry_join`),
          statusIndexName: uniqueTableName(`${adapter.tablePrefix}_retry_status_idx`),
          skuUniqueIndexName: uniqueTableName(`${adapter.tablePrefix}_retry_sku_uidx`),
          url: container.getConnectionUri(),
        });
        writePendingMigration(root, "npa/migrations", migrationName, [
          `ALTER TABLE ${adapter.quoteIdentifier(missingTableName)} ADD COLUMN broken INTEGER`,
        ]);

        const failed = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(failed.status).not.toEqual(0);

        queryable = await adapter.createQueryable(container);
        expect(await readMigrationHistory(adapter, queryable, migrationName)).toEqual(
          expect.objectContaining({ name: migrationName, status: "failed" }),
        );

        writePendingMigration(root, "npa/migrations", migrationName, [
          createAuditTableSql(adapter, auditTableName),
        ]);
        const retried = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(retried);
        expect(retried.stdout).toMatch(/Applied 1 migration\(s\)/);
        expect(await readMigrationHistory(adapter, queryable, migrationName)).toEqual(
          expect.objectContaining({ name: migrationName, status: "applied" }),
        );
        expect(await readColumnNames(adapter, queryable, auditTableName)).toEqual([
          "audit_id",
          "message",
        ]);
      } finally {
        try {
          if (queryable) {
            for (const table of [auditTableName, "_npa_migrations"]) {
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

    test(`backfills legacy migration history columns for ${adapter.name}`, async () => {
      const tableName = uniqueTableName(`${adapter.tablePrefix}_legacy_history`);
      const categoryTableName = uniqueTableName(`${adapter.tablePrefix}_legacy_category`);
      const joinTableName = uniqueTableName(`${adapter.tablePrefix}_legacy_join`);
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
          statusIndexName: uniqueTableName(`${adapter.tablePrefix}_legacy_status_idx`),
          skuUniqueIndexName: uniqueTableName(`${adapter.tablePrefix}_legacy_sku_uidx`),
          url: container.getConnectionUri(),
        });
        queryable = await adapter.createQueryable(container);
        await adapter.executeSql(queryable, createLegacyHistoryTableSql(adapter));

        const pushed = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(pushed);

        expect(await readColumnNames(adapter, queryable, "_npa_migrations")).toEqual(
          expect.arrayContaining(["status", "error_message"]),
        );
        expect(await readMigrationHistory(adapter, queryable, "schema")).toEqual(
          expect.objectContaining({ name: "schema", status: "applied" }),
        );
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

    test(`runs schema-qualified migrations for ${adapter.name}`, async () => {
      const schemaName = uniqueTableName(`${adapter.tablePrefix}_schema`);
      const tableName = uniqueTableName(`${adapter.tablePrefix}_qualified_products`);
      const historyTable = `${schemaName}.${uniqueTableName(`${adapter.tablePrefix}_history`)}`;
      const container = await startContainerOrSkip(adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      try {
        const connectionUri = adapter.adapterName === "mysql"
          ? container.getConnectionUri(true)
          : container.getConnectionUri();
        const adminContainer = { getConnectionUri: () => connectionUri };
        const root = makeQualifiedMigrationProject({
          adapter: adapter.adapterName,
          schemaName,
          tableName,
          historyTable,
          url: connectionUri,
        });
        const pushed = runCli(
          ["db", "push", "--config", "npa.config.mjs"],
          root,
        );
        expectCliSuccess(pushed);

        queryable = await adapter.createQueryable(adminContainer);
        expect(
          await readQualifiedColumnNames(adapter, queryable, schemaName, tableName),
        ).toEqual(["product_id", "product_name"]);
        expect(
          await readQualifiedMigrationHistory(adapter, queryable, historyTable, "schema"),
        ).toEqual(expect.objectContaining({ name: "schema", status: "applied" }));
      } finally {
        try {
          if (queryable) {
            await dropSchema(adapter, queryable, schemaName);
          }
        } finally {
          if (queryable) {
            await adapter.closeQueryable(queryable);
          }
          await container.stop();
        }
      }
    }, 240_000);

    test(`keeps migration deploy failure atomic for ${adapter.name}`, async () => {
      const firstTableName = uniqueTableName(`${adapter.tablePrefix}_atomic_first`);
      const secondTableName = uniqueTableName(`${adapter.tablePrefix}_atomic_second`);
      const missingTableName = uniqueTableName(`${adapter.tablePrefix}_atomic_missing`);
      const container = await startContainerOrSkip(adapter.createContainer());

      if (!container) {
        return;
      }

      let queryable;

      try {
        const root = makeMigrationProject({
          adapter: adapter.adapterName,
          tableName: uniqueTableName(`${adapter.tablePrefix}_atomic_product`),
          categoryTableName: uniqueTableName(`${adapter.tablePrefix}_atomic_category`),
          joinTableName: uniqueTableName(`${adapter.tablePrefix}_atomic_join`),
          statusIndexName: uniqueTableName(`${adapter.tablePrefix}_atomic_status_idx`),
          skuUniqueIndexName: uniqueTableName(`${adapter.tablePrefix}_atomic_sku_uidx`),
          url: container.getConnectionUri(),
        });
        writePendingMigration(root, "npa/migrations", "99999999999994_atomic_first", [
          createAuditTableSql(adapter, firstTableName),
        ]);
        writePendingMigration(root, "npa/migrations", "99999999999995_atomic_second", [
          createAuditTableSql(adapter, secondTableName),
          `ALTER TABLE ${adapter.quoteIdentifier(missingTableName)} ADD COLUMN broken INTEGER`,
        ]);

        const failed = runCli(
          ["migrate", "deploy", "--config", "npa.config.mjs"],
          root,
        );
        expect(failed.status).not.toEqual(0);

        queryable = await adapter.createQueryable(container);
        expect(await tableExists(adapter, queryable, firstTableName)).toEqual(
          adapter.adapterName === "mysql",
        );
        expect(await tableExists(adapter, queryable, secondTableName)).toEqual(
          adapter.adapterName === "mysql",
        );
        expect(
          await readMigrationHistory(adapter, queryable, "99999999999994_atomic_first"),
        ).toEqual(adapter.adapterName === "mysql"
          ? expect.objectContaining({ status: "applied" })
          : undefined);
        expect(
          await readMigrationHistory(adapter, queryable, "99999999999995_atomic_second"),
        ).toEqual(expect.objectContaining({ status: "failed" }));
      } finally {
        try {
          if (queryable) {
            for (const table of [secondTableName, firstTableName, "_npa_migrations"]) {
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

  test("generated init example runs migrate dry-run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "npa-init-e2e-"));
    const init = runCli(["init", "--db", "pg", "--example"], root);
    expectCliSuccess(init);

    const dryRun = runCli(["migrate", "--dry-run"], root);
    expectCliSuccess(dryRun);
    expect(dryRun.stdout).toMatch(/Adapter: postgresql/);
    expect(dryRun.stdout).toMatch(/CREATE TABLE IF NOT EXISTS/);
  });
});

function runCli(args, cwd) {
  ensureBuiltCli();

  return childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, "..", "..", "dist", "cli", "npa.js"), ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

function ensureBuiltCli() {
  const root = path.resolve(__dirname, "..", "..");
  const requiredFiles = [
    "dist/cli/npa.js",
    "packages/pg/dist/postgresql-migration.js",
    "packages/mysql/dist/mysql-migration.js",
  ];

  if (requiredFiles.every((file) => fs.existsSync(path.join(root, file)))) {
    return;
  }

  const result = childProcess.spawnSync("npm", ["run", "build"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to build CLI for E2E test.\n${result.stdout}${result.stderr}`);
  }
}

function expectCliSuccess(result) {
  if (result.status !== 0) {
    throw new Error(`Expected CLI status 0, received ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function makeMigrationProject(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npa-migrate-e2e-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "npa.config.mjs"),
    `export default {
      adapter: ${JSON.stringify(options.adapter)},
      url: ${JSON.stringify(options.url)},
      entities: ["src/**/*.entity.ts"],
      migrations: { dir: ${JSON.stringify(options.migrationsDir ?? "npa/migrations")} }
    };`,
    "utf8",
  );
  writeProductEntity(root, options);
  return root;
}

function makeEnumMigrationProject(options) {
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
  fs.writeFileSync(
    path.join(root, "src", "enum-product.entity.ts"),
    `
import { Column, Entity, EnumType, GenerationStrategy, Id } from "@node-persistence-api/core";

@Entity({ name: ${JSON.stringify(options.tableName)} })
export class EnumProduct {
  @Id({ generationStrategy: GenerationStrategy.AUTO_INCREMENT })
  id?: number;

  @Column({ enum: ["ACTIVE", "BLOCKED"] })
  status!: string;

  @Column({ enum: ["ADMIN", "USER"], enumType: EnumType.NATIVE, enumName: ${JSON.stringify(options.roleTypeName)} })
  role!: string;

  @Column({ enum: ["LOW", "HIGH"], enumType: EnumType.ORDINAL })
  priority!: string;

  @Column()
  tags!: string[];

  @Column()
  scores!: number[];
}
`,
    "utf8",
  );
  return root;
}

function makeQualifiedMigrationProject(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npa-migrate-e2e-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "npa.config.mjs"),
    `export default {
      adapter: ${JSON.stringify(options.adapter)},
      url: ${JSON.stringify(options.url)},
      entities: ["src/**/*.entity.ts"],
      migrations: { table: ${JSON.stringify(options.historyTable)} }
    };`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "src", "product.entity.ts"),
    `
import { Column, Entity, GenerationStrategy, Id } from "@node-persistence-api/core";

@Entity({ name: ${JSON.stringify(options.tableName)}, schema: ${JSON.stringify(options.schemaName)} })
export class Product {
  @Id({ name: "product_id", generationStrategy: GenerationStrategy.AUTO_INCREMENT })
  id?: number;

  @Column({ name: "product_name" })
  name!: string;
}
`,
    "utf8",
  );
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
  const statusOptions = columnOptions({
    index: options.withRelations ? options.statusIndexName : undefined,
    nullable: options.statusNullable ? true : undefined,
  });

  fs.writeFileSync(
    path.join(root, "src", "product.entity.ts"),
    `
import { Column, Entity, GenerationStrategy, Id, Version${options.withRelations ? ", ManyToMany" : ""} } from "@node-persistence-api/core";

@Entity({ name: ${JSON.stringify(options.tableName)} })
export class Product {
  @Id({ name: "product_id", generationStrategy: GenerationStrategy.AUTO_INCREMENT })
  id?: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;

  @Column(${options.withRelations ? "{ default: true }" : ""})
  active!: boolean;

  @Column(${statusOptions})
  status${options.statusNullable ? "?" : "!"}: string${options.statusNullable ? " | null" : ""};

  @Column({ name: "created_at" })
  createdAt!: Date;

  @Version()
  version!: number;
${options.withRelations ? "\n  @Column({ nullable: true, unique: " + JSON.stringify(options.skuUniqueIndexName) + " })\n  sku?: string | null;\n\n  @ManyToMany(() => Category, { joinTable: " + JSON.stringify(options.joinTableName) + " })\n  categories?: Category[];\n" : '\n  @Column({ name: "legacy_code", nullable: true })\n  legacyCode?: string | null;\n'}}
${
  options.withRelations
    ? `
@Entity({ name: ${JSON.stringify(options.categoryTableName)} })
export class Category {
  @Id({ name: "category_id", generationStrategy: GenerationStrategy.AUTO_INCREMENT })
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

function columnOptions(options) {
  const entries = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);

  return entries.length ? `{ ${entries.join(", ")} }` : "";
}

function writeRenamedProductEntity(root, options) {
  fs.writeFileSync(
    path.join(root, "src", "product.entity.ts"),
    `
import { Column, Entity, GenerationStrategy, Id, Version } from "@node-persistence-api/core";

@Entity({ name: ${JSON.stringify(options.tableName)} })
export class Product {
  @Id({ name: "product_id", generationStrategy: GenerationStrategy.AUTO_INCREMENT })
  id?: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;

  @Column()
  active!: boolean;

  @Column()
  status!: string;

  @Column({ name: "created_at" })
  createdAt!: Date;

  @Version()
  version!: number;

  @Column({ name: "external_code", nullable: true })
  externalCode?: string | null;
}
`,
    "utf8",
  );
}

function writePendingMigration(root, migrationsDir, name, statements) {
  const migrationRoot = path.join(root, migrationsDir, name);
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

function insertMigrationHistorySql(adapter, name) {
  return [
    `INSERT INTO ${adapter.quoteIdentifier("_npa_migrations")}`,
    "(name, checksum, adapter, statement_count)",
    `VALUES ('${name}', '${"a".repeat(64)}', '${adapter.adapterName}', 0)`,
  ].join("\n");
}

function createLegacyHistoryTableSql(adapter) {
  if (adapter.adapterName === "mysql") {
    return [
      "CREATE TABLE `_npa_migrations` (",
      "  name VARCHAR(255) PRIMARY KEY,",
      "  checksum VARCHAR(64) NOT NULL,",
      "  adapter VARCHAR(32) NOT NULL,",
      "  applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),",
      "  statement_count INT NOT NULL",
      ")",
    ].join("\n");
  }

  return [
    'CREATE TABLE "_npa_migrations" (',
    "  name TEXT PRIMARY KEY,",
    "  checksum TEXT NOT NULL,",
    "  adapter TEXT NOT NULL,",
    "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "  statement_count INTEGER NOT NULL",
    ")",
  ].join("\n");
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

async function readColumnNullable(adapter, queryable, tableName, columnName) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
          'SELECT is_nullable AS "isNullable"',
          "FROM information_schema.columns",
          "WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
        ].join("\n")
      : [
          "SELECT IS_NULLABLE AS isNullable",
          "FROM information_schema.columns",
          "WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        ].join("\n"),
    [tableName, columnName],
  );

  return rows[0]?.isNullable === "YES";
}

async function readColumnDbType(adapter, queryable, tableName, columnName) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
          'SELECT CASE WHEN data_type IN (\'USER-DEFINED\', \'ARRAY\') THEN udt_name ELSE data_type END AS "dbType"',
          "FROM information_schema.columns",
          "WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
        ].join("\n")
      : [
          "SELECT COLUMN_TYPE AS dbType",
          "FROM information_schema.columns",
          "WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        ].join("\n"),
    [tableName, columnName],
  );

  return rows[0]?.dbType;
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

async function readMigrationHistory(adapter, queryable, name) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
          'SELECT name, checksum, status, statement_count AS "statementCount", error_message AS "errorMessage" FROM "_npa_migrations"',
          "WHERE name = $1",
        ].join("\n")
      : [
          "SELECT name, checksum, status, statement_count AS statementCount, error_message AS errorMessage FROM `_npa_migrations`",
          "WHERE name = ?",
        ].join("\n"),
    [name],
  );

  return rows[0];
}

async function readQualifiedMigrationHistory(adapter, queryable, historyTable, name) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
          `SELECT name, status FROM ${quoteQualifiedTable(adapter, historyTable)}`,
          "WHERE name = $1",
        ].join("\n")
      : [
          `SELECT name, status FROM ${quoteQualifiedTable(adapter, historyTable)}`,
          "WHERE name = ?",
        ].join("\n"),
    [name],
  );

  return rows[0];
}

async function readQualifiedColumnNames(adapter, queryable, schemaName, tableName) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
          'SELECT column_name AS "columnName"',
          "FROM information_schema.columns",
          "WHERE table_schema = $1 AND table_name = $2",
          "ORDER BY ordinal_position",
        ].join("\n")
      : [
          "SELECT COLUMN_NAME AS columnName",
          "FROM information_schema.columns",
          "WHERE table_schema = ? AND table_name = ?",
          "ORDER BY ORDINAL_POSITION",
        ].join("\n"),
    [schemaName, tableName],
  );

  return rows.map((row) => row.columnName);
}

async function tableExists(adapter, queryable, tableName) {
  const rows = await queryRows(
    queryable,
    adapter.adapterName === "postgresql"
      ? [
          "SELECT 1 AS exists",
          "FROM information_schema.tables",
          "WHERE table_schema = 'public' AND table_name = $1",
        ].join("\n")
      : [
          "SELECT 1 AS `exists`",
          "FROM information_schema.tables",
          "WHERE table_schema = DATABASE() AND table_name = ?",
        ].join("\n"),
    [tableName],
  );

  return rows.length > 0;
}

async function dropSchema(adapter, queryable, schemaName) {
  const schema = adapter.quoteIdentifier(schemaName);

  await adapter.executeSql(
    queryable,
    adapter.adapterName === "postgresql"
      ? `DROP SCHEMA IF EXISTS ${schema} CASCADE`
      : `DROP DATABASE IF EXISTS ${schema}`,
  );
}

function quoteQualifiedTable(adapter, identifier) {
  return identifier
    .split(".")
    .map((part) => adapter.quoteIdentifier(part))
    .join(".");
}

async function queryRows(queryable, sql, values) {
  const result = await queryable.query(sql, values);

  if (Array.isArray(result)) {
    return Array.isArray(result[0]) ? result[0] : [];
  }

  return result.rows;
}
