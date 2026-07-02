import { describe, expect, test } from "@jest/globals";
import { compileMysqlMigrationStatements } from "../src";

const userSchema = {
  className: "User",
  filePath: "src/user.entity.ts",
  tableName: "users",
  columns: [
    {
      propertyName: "id",
      columnName: "id",
      tsType: "number",
      nullable: false,
      primary: true,
      version: false,
    },
    {
      propertyName: "email",
      columnName: "email",
      tsType: "string",
      nullable: false,
      primary: false,
      version: false,
    },
    {
      propertyName: "status",
      columnName: "status",
      tsType: "string",
      nullable: false,
      primary: false,
      version: false,
    },
  ],
  indexes: [
    { columns: ["status"], name: "idx_users_status", unique: false },
    { columns: ["email"], name: "uidx_users_email", unique: true },
  ],
  relations: [],
};
describe("MySQL migration compiler", () => {
  test("compiles MySQL migration DDL for tables and indexes", () => {
    expect(compileMysqlMigrationStatements({
        entities: [userSchema],
        historyTable: "_npa_migrations",
      })).toEqual([
        [
          "CREATE TABLE IF NOT EXISTS `_npa_migrations` (",
          "  name VARCHAR(255) PRIMARY KEY,",
          "  checksum VARCHAR(64) NOT NULL,",
          "  adapter VARCHAR(32) NOT NULL,",
          "  applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),",
          "  statement_count INT NOT NULL",
          ")",
        ].join("\n"),
        [
          "CREATE TABLE IF NOT EXISTS `users` (",
          "  `id` INT PRIMARY KEY,",
          "  `email` VARCHAR(255) NOT NULL,",
          "  `status` VARCHAR(255) NOT NULL",
          ")",
        ].join("\n"),
        "CREATE INDEX `idx_users_status` ON `users` (`status`)",
        "CREATE UNIQUE INDEX `uidx_users_email` ON `users` (`email`)",
      ]);
  });

  test("compiles explicit MySQL id generation strategies", () => {
    const statements = compileMysqlMigrationStatements({
      entities: [
        generatedSchema("AutoUser", "auto_users", {
          columnName: "id",
          tsType: "number",
          generationStrategy: "AUTO_INCREMENT",
        }),
        generatedSchema("UuidUser", "uuid_users", {
          columnName: "external_id",
          tsType: "string",
          generationStrategy: "UUID",
        }),
      ],
      historyTable: "_npa_migrations",
    });

    expect(statements).toContain([
      "CREATE TABLE IF NOT EXISTS `auto_users` (",
      "  `id` INT AUTO_INCREMENT PRIMARY KEY",
      ")",
    ].join("\n"));
    expect(statements).toContain([
      "CREATE TABLE IF NOT EXISTS `uuid_users` (",
      "  `external_id` CHAR(36) DEFAULT (UUID()) PRIMARY KEY",
      ")",
    ].join("\n"));

    expect(() => compileMysqlMigrationStatements({
      entities: [generatedSchema("SequenceUser", "sequence_users", {
        columnName: "id",
        tsType: "number",
        generationStrategy: "SEQUENCE",
      })],
    })).toThrow(/MySQL does not support GenerationStrategy\.SEQUENCE/);
  });
});

function generatedSchema(className, tableName, column) {
  return {
    className,
    filePath: `src/${tableName}.entity.ts`,
    tableName,
    columns: [{
      propertyName: "id",
      nullable: false,
      primary: true,
      version: false,
      ...column,
    }],
    indexes: [],
    relations: [],
  };
}
