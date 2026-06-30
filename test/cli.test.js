const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("prints CLI help when no command is provided", () => {
  const result = runCli([]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /npa generate/);
  assert.match(result.stdout, /npa db push/);
  assert.match(result.stdout, /npa migrate dev/);
  assert.match(result.stdout, /npa migrate deploy/);
});

test("rejects unsupported CLI adapter names", () => {
  const root = makeCliFixtureProject();
  const result = runCli(
    [
      "generate",
      "--adapter",
      "sqlite",
      "--entities",
      "src/**/*.entity.ts",
      "--out",
      "src/generated/npa.ts",
    ],
    root,
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported adapter "sqlite"/);
});

test("generates a client from CLI inline flags", () => {
  const root = makeCliFixtureProject();
  const outPath = path.join(root, "src", "generated", "npa.ts");
  const result = runCli(
    [
      "generate",
      "--adapter=mysql",
      "--entities=src/**/*.entity.ts",
      "--out=src/generated/npa.ts",
      "--core-library=@npa/core",
      "--adapter-library=@npa/mysql",
    ],
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Generated /);

  const generated = fs.readFileSync(outPath, "utf8");
  assert.match(generated, /import \{ NPARepository \} from "@npa\/core";/);
  assert.match(generated, /import \{ MysqlQueryable, createMysqlDerivedQueryRepository \} from "@npa\/mysql";/);
  assert.match(generated, /export interface NPAClient/);
  assert.match(generated, /product: ProductRepository;/);
});

test("prints migrate dry-run SQL", () => {
  const root = makeCliFixtureProject();
  const result = runCli(
    [
      "migrate",
      "--dry-run",
      "--adapter",
      "postgresql",
      "--entities",
      "src/**/*.entity.ts",
    ],
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Adapter: postgresql/);
  assert.match(result.stdout, /Checksum: [a-f0-9]{64}/);
  assert.match(result.stdout, /CREATE TABLE IF NOT EXISTS "_npa_migrations"/);
  assert.match(result.stdout, /CREATE TABLE IF NOT EXISTS "products"/);
  assert.match(result.stdout, /"product_id" SERIAL PRIMARY KEY/);
});

test("prints db push dry-run SQL", () => {
  const root = makeCliFixtureProject();
  const result = runCli(
    [
      "db",
      "push",
      "--dry-run",
      "--adapter",
      "postgresql",
      "--entities",
      "src/**/*.entity.ts",
    ],
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Adapter: postgresql/);
  assert.match(result.stdout, /CREATE TABLE IF NOT EXISTS "_npa_migrations"/);
  assert.match(result.stdout, /CREATE TABLE IF NOT EXISTS "products"/);
});

test("prints migrate dev dry-run SQL without migration history statements", () => {
  const root = makeCliFixtureProject();
  const result = runCli(
    [
      "migrate",
      "dev",
      "--dry-run",
      "--name",
      "init",
      "--adapter",
      "mysql",
      "--entities",
      "src/**/*.entity.ts",
    ],
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Adapter: mysql/);
  assert.match(result.stdout, /Migration name: init/);
  assert.match(result.stdout, /CREATE TABLE IF NOT EXISTS `products`/);
  assert.doesNotMatch(result.stdout, /_npa_migrations/);
});

test("skips migrate deploy when no migration files exist", () => {
  const root = makeCliFixtureProject();
  const result = runCli(
    [
      "migrate",
      "deploy",
      "--adapter",
      "postgresql",
      "--url",
      "postgresql://localhost/db",
    ],
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No migration files found in npa\/migrations/);
});

test("runs migrate dry-run from npa.config.mjs", () => {
  const root = makeCliFixtureProject();
  fs.writeFileSync(
    path.join(root, "npa.config.mjs"),
    `export default {
      adapter: "mysql",
      entities: ["src/**/*.entity.ts"]
    };`,
    "utf8",
  );
  const result = runCli(["migrate", "--dry-run"], root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Adapter: mysql/);
  assert.match(result.stdout, /CREATE TABLE IF NOT EXISTS `_npa_migrations`/);
  assert.match(result.stdout, /`product_id` INT AUTO_INCREMENT PRIMARY KEY/);
});

test("rejects migrate without url unless dry-run is used", () => {
  const root = makeCliFixtureProject();
  const result = runCli(
    [
      "migrate",
      "--adapter",
      "postgresql",
      "--entities",
      "src/**/*.entity.ts",
    ],
    root,
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires database url unless --dry-run/);
});

test("rejects unsupported migrate adapter names", () => {
  const root = makeCliFixtureProject();
  const result = runCli(
    [
      "migrate",
      "--dry-run",
      "--adapter",
      "sqlite",
      "--entities",
      "src/**/*.entity.ts",
    ],
    root,
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Migration adapter must be postgresql or mysql/);
});

test("generates TypeScript clients that compile for each adapter", () => {
  for (const adapter of ["postgresql", "mysql"]) {
    const root = makeCliFixtureProject({
      libraryImport: coreLibraryImport(),
    });
    const result = runCli(
      [
        "generate",
        "--adapter",
        adapter,
        "--entities",
        "src/**/*.entity.ts",
        "--out",
        "src/generated/npa.ts",
        "--core-library",
        coreLibraryImport(),
        "--adapter-library",
        adapterLibraryImport(adapter),
      ],
      root,
    );

    assert.equal(result.status, 0, result.stderr);
    compileProject(root);
    assert.equal(
      fs.existsSync(path.join(root, "dist", "generated", "npa.js")),
      true,
    );
  }
});

function runCli(args, cwd = process.cwd()) {
  return childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, "..", "dist", "cli", "npa.js"), ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

function makeCliFixtureProject(options = {}) {
  const library = options.libraryImport ?? "@npa/test";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npa-cli-"));
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          declaration: false,
          emitDecoratorMetadata: true,
          experimentalDecorators: true,
          module: "commonjs",
          moduleResolution: "node",
          outDir: "dist",
          rootDir: "src",
          baseUrl: ".",
          paths: {
            "@honeybeaers/npa": [library],
          },
          skipLibCheck: true,
          strict: true,
          target: "ES2021",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(src, "product.entity.ts"),
    `
import { Column, Entity, Id } from ${JSON.stringify(library)};

@Entity({ name: "products" })
export class Product {
  @Id({ name: "product_id" })
  id?: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;
}
`,
    "utf8",
  );

  return root;
}

function compileProject(root) {
  const result = childProcess.spawnSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function coreLibraryImport() {
  return path.resolve(__dirname, "..", "dist");
}

function adapterLibraryImport(adapter) {
  const packageName = adapter === "mysql" ? "mysql" : "pg";
  return path.resolve(__dirname, "..", "packages", packageName, "dist");
}
