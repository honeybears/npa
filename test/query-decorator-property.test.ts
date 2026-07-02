import { describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPostgresqlDerivedQueryRepository, type PostgresqlQueryable } from "../packages/pg/dist";

const repoRoot = path.resolve(__dirname, "..");
type DynamicRepository = Record<string, (...args: unknown[]) => Promise<unknown>>;

describe("query decorator property", () => {
  test("executes @Query on a decorated definite-assignment function property", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "npa-query-property-"));
    const sourcePath = path.join(tempDir, "query-property.ts");

    try {
      fs.writeFileSync(sourcePath, `
  import { Column, Entity, Id, NPARepository, Query } from ${JSON.stringify(path.join(repoRoot, "dist"))};

  class User {
    id!: number;
    email!: string;
    active!: boolean;
  }

  Id()(User.prototype, "id");
  Column()(User.prototype, "email");
  Column()(User.prototype, "active");
  Entity({ name: "users" })(User);

  abstract class UserRepository extends NPARepository<User, number> {
    @Query('SELECT * FROM users WHERE email = :email AND active = :active', { result: 'one' })
    findByEmailSql!: (email: string, active: boolean) => Promise<User | null>;
  }

  export { User, UserRepository };
  `, "utf8");

      const compile = spawnSync(
        path.join(repoRoot, "node_modules", ".bin", "tsc"),
        [
          "--target", "ES2021",
          "--module", "CommonJS",
          "--experimentalDecorators",
          "--strict",
          "--skipLibCheck",
          sourcePath,
        ],
        { encoding: "utf8" },
      );

      expect(compile.status).toEqual(0);

      const { User, UserRepository } = await import(path.join(tempDir, "query-property.js"));
      const calls = [];
      const queryable = {
        query(text, values = []) {
          calls.push({ text, values });
          return {
            rows: [{ id: 1, email: values[0], active: values[1] }],
            rowCount: 1,
          };
        },
      };
      const repository = createPostgresqlDerivedQueryRepository(
        Object.create(UserRepository.prototype),
        { entity: User, queryable: queryable as unknown as PostgresqlQueryable },
      ) as DynamicRepository;

      expect(await repository.findByEmailSql("a@b.com", true)).toEqual({
        id: 1,
        email: "a@b.com",
        active: true,
      });
      expect(calls).toEqual([
        {
          text: "SELECT * FROM users WHERE email = $1 AND active = $2",
          values: ["a@b.com", true],
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
