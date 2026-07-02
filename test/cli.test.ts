import { describe, expect, test } from "@jest/globals";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("migration CLI", () => {
  test("prints CLI help when no command is provided", () => {
    const result = runCli([]);

    expectCliSuccess(result);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).not.toMatch(/npa generate/);
    expect(result.stdout).toMatch(/npa db push/);
    expect(result.stdout).toMatch(/npa migrate dev/);
    expect(result.stdout).toMatch(/npa migrate deploy/);
  });

  test("rejects removed generate command", () => {
    const root = makeCliFixtureProject();
    const result = runCli(
      ["generate", "--entities", "src/**/*.entity.ts"],
      root,
    );

    expect(result.status).toEqual(1);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).not.toMatch(/npa generate/);
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

    expectCliSuccess(result);
    expect(result.stdout).toMatch(/Adapter: postgresql/);
    expect(result.stdout).toMatch(/Checksum: [a-f0-9]{64}/);
    expect(result.stdout).toMatch(
      /CREATE TABLE IF NOT EXISTS "_npa_migrations"/,
    );
    expect(result.stdout).toMatch(/CREATE TABLE IF NOT EXISTS "products"/);
    expect(result.stdout).toMatch(/"product_id" INTEGER PRIMARY KEY/);
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

    expectCliSuccess(result);
    expect(result.stdout).toMatch(/Adapter: postgresql/);
    expect(result.stdout).toMatch(
      /CREATE TABLE IF NOT EXISTS "_npa_migrations"/,
    );
    expect(result.stdout).toMatch(/CREATE TABLE IF NOT EXISTS "products"/);
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

    expectCliSuccess(result);
    expect(result.stdout).toMatch(/Adapter: mysql/);
    expect(result.stdout).toMatch(/Migration name: init/);
    expect(result.stdout).toMatch(/CREATE TABLE IF NOT EXISTS `products`/);
    expect(result.stdout).not.toMatch(/_npa_migrations/);
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

    expectCliSuccess(result);
    expect(result.stdout).toMatch(
      /No migration files found in npa\/migrations/,
    );
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

    expectCliSuccess(result);
    expect(result.stdout).toMatch(/Adapter: mysql/);
    expect(result.stdout).toMatch(
      /CREATE TABLE IF NOT EXISTS `_npa_migrations`/,
    );
    expect(result.stdout).toMatch(
      /`product_id` INT PRIMARY KEY/,
    );
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

    expect(result.status).toEqual(1);
    expect(result.stderr).toMatch(/requires database url unless --dry-run/);
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

    expect(result.status).toEqual(1);
    expect(result.stderr).toMatch(
      /Migration adapter must be postgresql or mysql/,
    );
  });
});

function runCli(
  args: string[],
  cwd = process.cwd(),
): childProcess.SpawnSyncReturns<string> {
  ensureBuiltCli();

  return childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, "..", "dist", "cli", "npa.js"), ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

function expectCliSuccess(result: childProcess.SpawnSyncReturns<string>): void {
  if (result.status !== 0) {
    throw new Error(`Expected CLI status 0, received ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function ensureBuiltCli(): void {
  const root = path.resolve(__dirname, "..");
  const requiredFiles = [
    "dist/cli/npa.js",
    "packages/pg/dist/postgresql-migration.js",
    "packages/mysql/dist/mysql-migration.js",
  ];

  if (requiredFiles.every((file) => fs.existsSync(path.join(root, file)))) {
    return;
  }

  const result = childProcess.spawnSync("npm", ["run", "build"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to build CLI for test.\n${result.stdout}${result.stderr}`);
  }
}

function makeCliFixtureProject() {
  const library = "@npa/test";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npa-cli-"));
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "@node-persistence-api"), {
    recursive: true,
  });
  fs.symlinkSync(
    path.resolve(__dirname, ".."),
    path.join(root, "node_modules", "@node-persistence-api", "core"),
    "dir",
  );
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
            "@node-persistence-api/core": [library],
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
