import { describe, expect, test } from "@jest/globals";
import { compilePostgresqlMigrationStatements } from "../src";

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
describe("PostgreSQL migration compiler", () => {
  test("compiles PostgreSQL migration DDL for tables and indexes", () => {
    expect(compilePostgresqlMigrationStatements({
        entities: [userSchema],
        historyTable: "_npa_migrations",
      })).toEqual([
        [
          'CREATE TABLE IF NOT EXISTS "_npa_migrations" (',
          "  name TEXT PRIMARY KEY,",
          "  checksum TEXT NOT NULL,",
          "  adapter TEXT NOT NULL,",
          "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
          "  statement_count INTEGER NOT NULL",
          ")",
        ].join("\n"),
        [
          'CREATE TABLE IF NOT EXISTS "users" (',
          '  "id" SERIAL PRIMARY KEY,',
          '  "email" TEXT NOT NULL,',
          '  "status" TEXT NOT NULL',
          ")",
        ].join("\n"),
        'CREATE INDEX IF NOT EXISTS "idx_users_status" ON "users" ("status")',
        'CREATE UNIQUE INDEX IF NOT EXISTS "uidx_users_email" ON "users" ("email")',
      ]);
  });
});
