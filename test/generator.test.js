const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  generateNPAClient,
  parseEntityFile,
} = require("../dist");

test("parses entity source files for CLI generation", () => {
  const root = makeFixtureProject();
  const entities = parseEntityFile(path.join(root, "src", "user.entity.ts"));

  assert.deepEqual(entities, [
    {
      className: "User",
      filePath: path.join(root, "src", "user.entity.ts"),
      columns: [
        { propertyName: "id", type: "number", primary: true },
        { propertyName: "name", type: "string", primary: false },
        { propertyName: "age", type: "number", primary: false },
        { propertyName: "active", type: "boolean", primary: false },
        { propertyName: "createdAt", type: "Date", primary: false },
        { propertyName: "version", type: "number", primary: false },
      ],
    },
  ]);
});

test("generates autocomplete repository interfaces and an NPA client factory", () => {
  const root = makeFixtureProject();
  const result = generateNPAClient({
    cwd: root,
    entities: ["src/**/*.entity.ts"],
    out: "src/generated/npa.ts",
    adapter: "postgresql",
    coreLibraryImport: "@npa/core",
    adapterLibraryImport: "@npa/pg",
  });

  assert.equal(result.path, path.join(root, "src", "generated", "npa.ts"));
  assert.match(result.content, /import \{ NPARepository \} from "@npa\/core";/);
  assert.match(
    result.content,
    /import \{ PostgresqlQueryable, createPostgresqlDerivedQueryRepository \} from "@npa\/pg";/,
  );
  assert.match(result.content, /interface UserRepository extends NPARepository<User, number>/);
  assert.match(result.content, /findByNameContaining\(value: NonNullable<User\["name"\]>\): Promise<User\[]>;/);
  assert.match(result.content, /deleteByNameContaining\(value: NonNullable<User\["name"\]>\): Promise<number>;/);
  assert.match(result.content, /findByAgeGreaterThan\(value: NonNullable<User\["age"\]>\): Promise<User\[]>;/);
  assert.match(result.content, /countByAgeBetween\(min: NonNullable<User\["age"\]>, max: NonNullable<User\["age"\]>\): Promise<number>;/);
  assert.match(result.content, /findByActiveTrue\(\): Promise<User\[]>;/);
  assert.match(
    result.content,
    /findByVersion\(value: NonNullable<User\["version"\]>\): Promise<User\[]>;/,
  );
  assert.doesNotMatch(result.content, /findById\(value: NonNullable<User\["id"\]>\): Promise<User\[]>;/);
  assert.match(result.content, /user: UserRepository;/);
  assert.match(result.content, /createPostgresqlDerivedQueryRepository<UserRepository, User, number>\(\{\} as UserRepository,/);
  assert.equal(fs.readFileSync(result.path, "utf8"), result.content);
});

test("generates a MySQL-backed NPA client factory", () => {
  const root = makeFixtureProject();
  const result = generateNPAClient({
    cwd: root,
    entities: ["src/**/*.entity.ts"],
    out: "src/generated/npa.mysql.ts",
    adapter: "mysql",
    coreLibraryImport: "@npa/core",
    adapterLibraryImport: "@npa/mysql",
  });

  assert.match(
    result.content,
    /import \{ NPARepository \} from "@npa\/core";/,
  );
  assert.match(
    result.content,
    /import \{ MysqlQueryable, createMysqlDerivedQueryRepository \} from "@npa\/mysql";/,
  );
  assert.match(result.content, /mysql: \{/);
  assert.match(result.content, /queryable: MysqlQueryable;/);
  assert.match(result.content, /createMysqlDerivedQueryRepository<UserRepository, User, number>\(\{\} as UserRepository,/);
  assert.doesNotMatch(result.content, /createPostgresqlDerivedQueryRepository/);
});

test("runs npa generate from the compiled CLI", () => {
  const root = makeFixtureProject();
  const cliPath = path.resolve(__dirname, "..", "dist", "cli", "npa.js");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      cliPath,
      "generate",
      "--entities",
      "src/**/*.entity.ts",
      "--out",
      "src/generated/npa.ts",
      "--library",
      "@npa/test",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Generated /);
  assert.match(
    fs.readFileSync(path.join(root, "src", "generated", "npa.ts"), "utf8"),
    /export interface NPAClient/,
  );
});

test("runs npa generate with the mysql adapter from the compiled CLI", () => {
  const root = makeFixtureProject();
  const cliPath = path.resolve(__dirname, "..", "dist", "cli", "npa.js");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      cliPath,
      "generate",
      "--adapter",
      "mysql",
      "--entities",
      "src/**/*.entity.ts",
      "--out",
      "src/generated/npa.ts",
      "--library",
      "@npa/test",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    fs.readFileSync(path.join(root, "src", "generated", "npa.ts"), "utf8"),
    /createMysqlDerivedQueryRepository/,
  );
});

function makeFixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npa-generate-"));
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, "user.entity.ts"),
    `
import { Column, Entity, Id, ManyToOne, Version } from "@npa/test";
import { Team } from "./team.entity";

@Entity({ name: "users" })
export class User {
  @Id({ name: "user_id" })
  id?: number;

  @Column()
  name!: string;

  @Column()
  age!: number;

  @Column()
  active!: boolean;

  @Column({ name: "created_at" })
  createdAt!: Date;

  @Version()
  version!: number;

  @ManyToOne(() => Team)
  team?: Team;
}
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(src, "team.entity.ts"),
    `
import { Column, Entity, Id } from "@npa/test";

@Entity({ name: "teams" })
export class Team {
  @Id()
  id?: number;

  @Column()
  name!: string;
}
`,
    "utf8",
  );

  return root;
}
