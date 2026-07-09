import { describe, expect, test } from "@jest/globals";
import * as core from "../src";
import * as adapterApi from "../src/adapter";
import * as mysql from "../packages/mysql/src";
import * as postgresql from "../packages/pg/src";

describe("public package exports", () => {
  test("keeps core implementation helpers behind the adapter entrypoint", () => {
    expect(core).toHaveProperty("createNPA");
    expect(core).not.toHaveProperty("createNPARepository");
    expect(core).not.toHaveProperty("getEntityMetadata");
    expect(core).not.toHaveProperty("PersistenceContext");
    expect(adapterApi).toHaveProperty("createNPARepository");
    expect(adapterApi).toHaveProperty("getEntityMetadata");
  });

  test("does not expose connector compilers or executors from package roots", () => {
    expect(postgresql).toHaveProperty("postgresql");
    expect(postgresql).toHaveProperty("migratePostgresql");
    expect(postgresql).not.toHaveProperty("compilePostgresqlQuery");
    expect(postgresql).not.toHaveProperty("PostgresqlRepositoryExecutor");

    expect(mysql).toHaveProperty("mysql");
    expect(mysql).toHaveProperty("migrateMysql");
    expect(mysql).not.toHaveProperty("compileMysqlQuery");
    expect(mysql).not.toHaveProperty("MysqlRepositoryExecutor");
  });
});
