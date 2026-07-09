import { describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

describe("query decorator property", () => {
  test("executes @Query on a decorated definite-assignment function property", async () => {
    ensureBuiltDist();

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

      const runner = spawnSync(
        process.execPath,
        [
          "-e",
          `
  const assert = require("node:assert/strict");
  const { createPostgresqlDerivedQueryRepository } = require(${JSON.stringify(path.join(repoRoot, "packages/pg/dist/create-postgresql-derived-query-repository.js"))});
  const { User, UserRepository } = require(${JSON.stringify(path.join(tempDir, "query-property.js"))});
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
    { entity: User, queryable },
  );

  repository.findByEmailSql("a@b.com", true)
    .then((result) => {
      assert.deepEqual(result, { id: 1, email: "a@b.com", active: true });
      assert.deepEqual(calls, [{
        text: "SELECT * FROM users WHERE email = $1 AND active = $2",
        values: ["a@b.com", true],
      }]);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `,
        ],
        { encoding: "utf8" },
      );

      expect(runner.status).toEqual(0);
      expect(runner.stderr).toEqual("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function ensureBuiltDist(): void {
  const requiredFiles = [
    "dist/index.js",
    "packages/pg/dist/index.js",
  ];

  if (requiredFiles.every((file) => fs.existsSync(path.join(repoRoot, file)))) {
    return;
  }

  const result = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to build dist for test.\n${result.stdout}${result.stderr}`);
  }
}
