import { describe, expect, test } from "@jest/globals";
import { compilePostgresqlMigrationStatements } from "../src/postgresql-migration";

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
          "  statement_count INTEGER NOT NULL,",
          "  status TEXT NOT NULL DEFAULT 'applied',",
          "  error_message TEXT",
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

  test("compiles BigInteger columns as BIGINT", () => {
    const statements = compilePostgresqlMigrationStatements({
      entities: [{
        ...userSchema,
        columns: [
          ...userSchema.columns,
          {
            propertyName: "total",
            columnName: "total",
            tsType: "BigInteger",
            nullable: false,
            primary: false,
            version: false,
          },
        ],
      }],
    });

    expect(statements).toContain([
      'CREATE TABLE IF NOT EXISTS "users" (',
      '  "id" INTEGER PRIMARY KEY,',
      '  "email" TEXT NOT NULL,',
      '  "status" TEXT NOT NULL,',
      '  "total" BIGINT NOT NULL',
      ")",
    ].join("\n"));
  });

  test("compiles TypeScript arrays as native PostgreSQL arrays", () => {
    const statements = compilePostgresqlMigrationStatements({
      entities: [{
        ...userSchema,
        columns: [
          ...userSchema.columns,
          {
            propertyName: "tags",
            columnName: "tags",
            tsType: "string[]",
            nullable: false,
            primary: false,
            version: false,
            array: true,
          },
          {
            propertyName: "scores",
            columnName: "scores",
            tsType: "Array<number>",
            nullable: false,
            primary: false,
            version: false,
            array: true,
          },
        ],
      }],
    });

    expect(statements).toContain([
      'CREATE TABLE IF NOT EXISTS "users" (',
      '  "id" INTEGER PRIMARY KEY,',
      '  "email" TEXT NOT NULL,',
      '  "status" TEXT NOT NULL,',
      '  "tags" TEXT[] NOT NULL,',
      '  "scores" INTEGER[] NOT NULL',
      ")",
    ].join("\n"));
  });

  test("compiles enum columns as STRING checks by default and native enums when requested", () => {
    const statements = compilePostgresqlMigrationStatements({
      entities: [{
        ...userSchema,
        columns: [
          ...userSchema.columns,
          {
            propertyName: "role",
            columnName: "role",
            tsType: "string",
            nullable: false,
            primary: false,
            version: false,
            enumValues: ["ADMIN", "USER"],
            enumType: "NATIVE",
            enumName: "user_role",
          },
          {
            propertyName: "state",
            columnName: "state",
            tsType: "UserState",
            nullable: false,
            primary: false,
            version: false,
            enumValues: ["ACTIVE", "BLOCKED"],
          },
          {
            propertyName: "priority",
            columnName: "priority",
            tsType: "string",
            nullable: false,
            primary: false,
            version: false,
            enumValues: ["LOW", "HIGH"],
            enumType: "ORDINAL",
          },
        ],
      }],
    });

    expect(statements.some((statement) =>
      statement.includes('CREATE TYPE "user_role" AS ENUM (\'ADMIN\', \'USER\')'),
    )).toBeTruthy();
    expect(statements.some((statement) =>
      statement.includes('"role" "user_role" NOT NULL'),
    )).toBeTruthy();
    expect(statements.some((statement) =>
      statement.includes('CHECK ("state" IN (\'ACTIVE\', \'BLOCKED\'))'),
    )).toBeTruthy();
    expect(statements.some((statement) =>
      statement.includes('"priority" INTEGER NOT NULL'),
    )).toBeTruthy();
    expect(statements.some((statement) =>
      statement.includes('CHECK ("priority" IN (0, 1))'),
    )).toBeTruthy();
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
