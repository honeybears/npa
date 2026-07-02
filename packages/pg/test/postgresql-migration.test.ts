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
          '  "id" INTEGER PRIMARY KEY,',
          '  "email" TEXT NOT NULL,',
          '  "status" TEXT NOT NULL',
          ")",
        ].join("\n"),
        'CREATE INDEX IF NOT EXISTS "idx_users_status" ON "users" ("status")',
        'CREATE UNIQUE INDEX IF NOT EXISTS "uidx_users_email" ON "users" ("email")',
      ]);
  });

  test("compiles explicit PostgreSQL id generation strategies", () => {
    const statements = compilePostgresqlMigrationStatements({
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
        generatedSchema("SequenceUser", "sequence_users", {
          columnName: "ticket_id",
          tsType: "number",
          generationStrategy: "SEQUENCE",
          sequenceName: "user_ticket_seq",
        }),
      ],
      historyTable: "_npa_migrations",
    });

    expect(statements).toContain([
      'CREATE TABLE IF NOT EXISTS "auto_users" (',
      '  "id" SERIAL PRIMARY KEY',
      ")",
    ].join("\n"));
    expect(statements).toContain([
      'CREATE TABLE IF NOT EXISTS "uuid_users" (',
      '  "external_id" UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      ")",
    ].join("\n"));
    expect(statements).toContain('CREATE SEQUENCE IF NOT EXISTS "user_ticket_seq"');
    expect(statements).toContain([
      'CREATE TABLE IF NOT EXISTS "sequence_users" (',
      '  "ticket_id" INTEGER PRIMARY KEY DEFAULT nextval(\'"user_ticket_seq"\')',
      ")",
    ].join("\n"));
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
