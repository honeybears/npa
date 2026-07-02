const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createPostgresqlDerivedQueryRepository,
} = require("../packages/pg/dist");

const repoRoot = path.resolve(__dirname, "..");

test("executes @Query on a decorated definite-assignment function property", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "npa-query-property-"));
  const sourcePath = path.join(tempDir, "query-property.ts");

  try {
    fs.writeFileSync(sourcePath, `
const { Column, Entity, Id, NPARepository, Query } = require(${JSON.stringify(path.join(repoRoot, "dist"))});

class User {
  id!: number;
  email!: string;
  active!: boolean;
}

Id()(User.prototype, "id");
Column()(User.prototype, "email");
Column()(User.prototype, "active");
Entity({ name: "users" })(User);

class UserRepository extends NPARepository {
  @Query('SELECT * FROM users WHERE email = :email AND active = :active', { result: 'one' })
  findByEmailSql!: (email: string, active: boolean) => Promise<User | null>;
}

module.exports = { User, UserRepository };
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

    assert.equal(compile.status, 0, compile.stderr || compile.stdout);

    const { User, UserRepository } = require(path.join(tempDir, "query-property.js"));
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

    assert.deepEqual(await repository.findByEmailSql("a@b.com", true), {
      id: 1,
      email: "a@b.com",
      active: true,
    });
    assert.deepEqual(calls, [
      {
        text: "SELECT * FROM users WHERE email = $1 AND active = $2",
        values: ["a@b.com", true],
      },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
