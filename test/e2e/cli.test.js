const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertRepositoryContract,
  databaseAdapters,
  runDatabaseFlow,
} = require("./database-flow");

for (const adapter of databaseAdapters) {
  test(
    `runs CLI-generated ${adapter.name} client E2E against a real database`,
    { timeout: 240_000 },
    (t) =>
      runDatabaseFlow(t, adapter, async ({ queryable, tableName }) => {
        const root = makeCliE2EProject(tableName);
        const generatedPath = generateClient(root, adapter.adapterName);
        compileProject(root);

        const { createNPAClient } = require(toCompiledPath(root, generatedPath));
        const client = createNPAClient({
          [adapter.adapterName]: {
            queryable,
          },
        });

        assert.ok(client.product);
        await assertRepositoryContract(client.product);
      }),
  );
}

function generateClient(root, adapterName) {
  const cliPath = path.resolve(__dirname, "..", "..", "dist", "cli", "npa.js");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      cliPath,
      "generate",
      "--adapter",
      adapterName,
      "--entities",
      "src/**/*.entity.ts",
      "--out",
      "src/generated/npa.ts",
      "--core-library",
      coreLibraryImport(),
      "--adapter-library",
      adapterLibraryImport(adapterName),
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Generated /);
  assert.match(
    fs.readFileSync(path.join(root, "src", "generated", "npa.ts"), "utf8"),
    /create(?:Postgresql|Mysql)DerivedQueryRepository<ProductRepository, Product, number>\(\{\} as ProductRepository,/,
  );

  return path.join(root, "src", "generated", "npa.ts");
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

function makeCliE2EProject(tableName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npa-cli-e2e-"));
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          declaration: false,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          experimentalDecorators: true,
          module: "commonjs",
          moduleResolution: "node",
          outDir: "dist",
          rootDir: "src",
          baseUrl: ".",
          paths: {
            "@honeybeaers/npa": [coreLibraryImport()],
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
import { Column, Entity, Id, Version } from ${JSON.stringify(coreLibraryImport())};

@Entity({ name: ${JSON.stringify(tableName)} })
export class Product {
  @Id({ name: "product_id" })
  id?: number;

  @Column({ name: "product_name" })
  name!: string;

  @Column()
  price!: number;

  @Column()
  active!: boolean;

  @Column()
  status!: string;

  @Column({ name: "created_at" })
  createdAt!: Date;

  @Version()
  version!: number;
}
`,
    "utf8",
  );

  return root;
}

function coreLibraryImport() {
  return path.resolve(__dirname, "..", "..", "dist");
}

function adapterLibraryImport(adapterName) {
  const packageName = adapterName === "mysql" ? "mysql" : "pg";
  return path.resolve(__dirname, "..", "..", "packages", packageName, "dist");
}

function toCompiledPath(root, sourcePath) {
  const relative = path.relative(path.join(root, "src"), sourcePath);
  return path.join(root, "dist", relative).replace(/\.[cm]?ts$/, ".js");
}
