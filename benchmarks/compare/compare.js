#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "../..");
const TABLE_NAME = "npa_compare_users";
const DEFAULT_DURATION_SECONDS = 10;
const DEFAULT_VIRTUAL_USERS = 10;
const DEFAULT_POOL_SIZE = 10;
const DEFAULT_SEED_ROWS = 1_000;
const DEFAULT_REPEAT = 1;

let blackhole = 0;
let prismaClientReady = false;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const skipped = [];
  const reports = [];
  let targetCount = 0;

  for (const orm of options.orms) {
    const target = await resolvePostgresqlTarget(options, skipped, orm);

    if (!target) {
      continue;
    }

    targetCount += 1;

    if (target.external && !options.allowDestructive) {
      throw new Error([
        "Refusing to drop/recreate npa_compare_users on an existing database.",
        "Pass --allow-destructive only for a disposable benchmark database.",
      ].join(" "));
    }

    const { Pool } = require("pg");
    const setupPool = new Pool({ connectionString: target.url, max: 1 });

    try {
      for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
        for (const scenario of selectedScenarios(options)) {
          let client;

          try {
            await recreateBenchmarkTable(setupPool, options.seedRows);
            client = await createOrmClient(orm, target.url, options);
            reports.push({
              ...(await runScenario(client, scenario, options)),
              repeat,
            });
          } catch (error) {
            skipped.push({ name: `${orm} ${scenario} repeat ${repeat}`, reason: error.message });
          } finally {
            await client?.cleanup?.().catch(() => {});
          }
        }
      }
    } finally {
      await setupPool.query(`DROP TABLE IF EXISTS ${TABLE_NAME}`).catch(() => {});
      await setupPool.end().catch(() => {});
      await target.cleanup?.().catch(() => {});
    }
  }

  if (targetCount === 0) {
    throw new Error("No PostgreSQL target is available.");
  }

  const summary = aggregateReports(reports);

  if (options.json) {
    console.log(JSON.stringify({ reports, summary, skipped, blackhole }, null, 2));
    return;
  }

  printReport(summary, skipped, options);
}

async function createOrmClient(orm, url, options) {
  switch (orm) {
    case "npa":
      return createNpaClient(url, options);
    case "prisma":
      return createPrismaClient(url, options);
    case "typeorm":
      return createTypeormClient(url, options);
    default:
      throw new Error(`Unknown ORM lane: ${orm}`);
  }
}

function createNpaClient(url, options) {
  const { Pool } = require("pg");
  const npaPg = require(path.join(
    ROOT_DIR,
    "packages/pg/dist/create-postgresql-derived-query-repository.js",
  ));
  const pool = new Pool({ connectionString: url, max: options.poolSize });
  const repository = npaPg.createPostgresqlDerivedQueryRepository({}, {
    queryable: pool,
    tableName: TABLE_NAME,
    primaryKey: "id",
    columns: { createdAt: "created_at" },
  });

  return {
    name: "NPA",
    listUsers: () => repository.findTop10ByNameContainingOrderByIdDesc("bench"),
    getById: (id) => repository.findOneById(id),
    createUser: (data) => repository.insert(data),
    cleanup: () => pool.end(),
  };
}

async function createPrismaClient(url, options) {
  ensurePrismaClient(options);
  process.env.DATABASE_URL = url;

  const { PrismaClient } = require("@prisma/client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  if (!prisma.benchUser) {
    throw new Error("Generated Prisma Client does not include BenchUser. Run `pnpm --filter npa-orm-comparison-benchmark prepare:prisma`.");
  }

  await prisma.$connect();

  return {
    name: "Prisma",
    listUsers: () => prisma.benchUser.findMany({
      where: { name: { contains: "bench" } },
      orderBy: { id: "desc" },
      take: 10,
    }),
    getById: (id) => prisma.benchUser.findUnique({ where: { id } }),
    createUser: (data) => prisma.benchUser.create({ data }),
    cleanup: () => prisma.$disconnect(),
  };
}

async function createTypeormClient(url, options) {
  let typeorm;

  try {
    typeorm = require("typeorm");
  } catch (error) {
    throw new Error(`typeorm is unavailable: ${error.message}`, { cause: error });
  }

  const dataSource = new typeorm.DataSource({
    type: "postgres",
    url,
    entities: [createTypeormEntitySchema(typeorm)],
    synchronize: false,
    logging: false,
    extra: { max: options.poolSize },
  });

  await dataSource.initialize();
  const repository = dataSource.getRepository("BenchUser");

  return {
    name: "TypeORM",
    listUsers: () => repository.find({
      where: { name: typeorm.Like("%bench%") },
      order: { id: "DESC" },
      take: 10,
    }),
    getById: (id) => repository.findOneBy({ id }),
    createUser: async (data) => {
      const result = await repository
        .createQueryBuilder()
        .insert()
        .values(data)
        .returning("*")
        .execute();

      return result.raw[0] ?? null;
    },
    cleanup: () => dataSource.destroy(),
  };
}

function createTypeormEntitySchema(typeorm) {
  return new typeorm.EntitySchema({
    name: "BenchUser",
    tableName: TABLE_NAME,
    columns: {
      id: { type: Number, primary: true, generated: true },
      email: { type: String, unique: true },
      name: { type: String },
      age: { type: Number },
      createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    },
  });
}

function ensurePrismaClient(options) {
  if (prismaClientReady) {
    return;
  }

  if (!options.skipPrismaGenerate) {
    const prismaBin = resolveBin("prisma");

    if (!prismaBin) {
      throw new Error("prisma CLI is unavailable. Run `cd benchmarks/compare && pnpm install`.");
    }

    execFileSync(prismaBin, ["generate", "--schema", path.join(__dirname, "prisma/schema.prisma")], {
      cwd: __dirname,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL ?? "postgres://user:pass@localhost:5432/db",
      },
      stdio: options.verbose ? "inherit" : "pipe",
    });
  }

  try {
    require.resolve("@prisma/client");
  } catch (error) {
    throw new Error(`@prisma/client is unavailable: ${error.message}`, { cause: error });
  }

  prismaClientReady = true;
}

function resolveBin(name) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const candidates = [
    path.join(__dirname, "node_modules/.bin", `${name}${suffix}`),
    path.join(ROOT_DIR, "node_modules/.bin", `${name}${suffix}`),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function resolvePostgresqlTarget(options, skipped) {
  const url = options.pgUrl ?? process.env.NPA_COMPARE_PG_URL ?? process.env.NPA_BENCH_PG_URL;

  if (url) {
    return { url, external: true };
  }

  let PostgreSqlContainer;

  try {
    ({ PostgreSqlContainer } = require("@testcontainers/postgresql"));
  } catch (error) {
    skipped.push({
      name: "postgresql target",
      reason: `@testcontainers/postgresql is unavailable: ${error.message}`,
    });
    return null;
  }

  const image = process.env.NPA_COMPARE_POSTGRESQL_IMAGE ?? process.env.NPA_BENCH_POSTGRESQL_IMAGE ?? "postgres:16-alpine";

  try {
    const container = await new PostgreSqlContainer(image).start();
    return {
      url: container.getConnectionUri(),
      external: false,
      cleanup: () => container.stop(),
    };
  } catch (error) {
    if (isMissingContainerRuntimeError(error)) {
      skipped.push({ name: "postgresql target", reason: "No Docker/container runtime is available for Testcontainers." });
      return null;
    }

    throw error;
  }
}

async function recreateBenchmarkTable(pool, seedRows) {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  await pool.query(
    `INSERT INTO ${TABLE_NAME} (email, name, age)
     SELECT 'user' || g || '@example.com', 'bench user ' || g, 20 + (g % 50)
     FROM generate_series(1, $1) AS g`,
    [seedRows],
  );
}

async function runScenario(client, scenario, options) {
  switch (scenario) {
    case "read-heavy":
      return runReadHeavyScenario(client, options);
    case "write-and-read":
      return runWriteAndReadScenario(client, options);
    default:
      throw new Error(`Unknown benchmark scenario: ${scenario}`);
  }
}

async function runReadHeavyScenario(client, options) {
  const metrics = createScenarioMetrics(["List Users", "Get By ID"]);
  const startedAt = performance.now();
  const deadline = startedAt + options.durationSeconds * 1000;

  await Promise.all(Array.from({ length: options.virtualUsers }, (_, vu) =>
    runUntilDeadline(deadline, async (iteration) => {
      await recordOperation(metrics, "List Users", () => client.listUsers());
      await recordOperation(metrics, "Get By ID", () => client.getById(((iteration + vu) % options.seedRows) + 1));
    }),
  ));

  const durationSeconds = (performance.now() - startedAt) / 1000;
  const totalReads = sumMetricCounts(metrics);

  return {
    orm: client.name,
    scenario: "Read-Heavy",
    durationSeconds: round(durationSeconds, 3),
    operationsPerSecond: round(totalReads / durationSeconds, 2),
    totalOperations: totalReads,
    totalErrors: sumMetricErrors(metrics),
    metrics: summarizeMetrics(metrics),
  };
}

async function runWriteAndReadScenario(client, options) {
  const metrics = createScenarioMetrics(["Create User", "Get User"]);
  const state = { sequence: 0 };
  const startedAt = performance.now();
  const deadline = startedAt + options.durationSeconds * 1000;
  const ormSlug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  await Promise.all(Array.from({ length: options.virtualUsers }, (_, vu) =>
    runUntilDeadline(deadline, async () => {
      const sequence = state.sequence++;
      const created = await recordOperation(metrics, "Create User", () => client.createUser({
        email: `write-${ormSlug}-${process.pid}-${vu}-${sequence}@example.com`,
        name: `write user ${sequence}`,
        age: 20 + (sequence % 50),
      }));

      if (created?.id !== undefined && created.id !== null) {
        await recordOperation(metrics, "Get User", () => client.getById(created.id));
      }
    }),
  ));

  const durationSeconds = (performance.now() - startedAt) / 1000;
  const totalIterations = Math.min(metrics.get("Create User").count, metrics.get("Get User").count);

  return {
    orm: client.name,
    scenario: "Write-and-Read",
    durationSeconds: round(durationSeconds, 3),
    operationsPerSecond: round(totalIterations / durationSeconds, 2),
    totalOperations: totalIterations,
    totalErrors: sumMetricErrors(metrics),
    metrics: summarizeMetrics(metrics),
  };
}

async function runUntilDeadline(deadline, work) {
  let iteration = 0;

  while (performance.now() < deadline) {
    await work(iteration);
    iteration += 1;
  }
}

async function recordOperation(metrics, name, operation) {
  const metric = metrics.get(name);
  const startedAt = performance.now();

  try {
    const result = await operation();
    metric.latenciesMs.push(performance.now() - startedAt);
    metric.count += 1;
    consume(result);
    return result;
  } catch (error) {
    metric.errors += 1;
    metric.lastError = error.message;
    return undefined;
  }
}

function createScenarioMetrics(names) {
  return new Map(names.map((name) => [name, { count: 0, errors: 0, latenciesMs: [], lastError: undefined }]));
}

function summarizeMetrics(metrics) {
  const summary = {};

  for (const [name, metric] of metrics) {
    const sorted = [...metric.latenciesMs].sort((left, right) => left - right);
    summary[name] = {
      count: metric.count,
      errors: metric.errors,
      averageMs: round(average(sorted), 3),
      p50Ms: round(percentile(sorted, 0.50), 3),
      p95Ms: round(percentile(sorted, 0.95), 3),
      p99Ms: round(percentile(sorted, 0.99), 3),
      lastError: metric.lastError,
    };
  }

  return summary;
}

function aggregateReports(reports) {
  const groups = new Map();

  for (const report of reports) {
    const key = `${report.orm}\0${report.scenario}`;
    let group = groups.get(key);

    if (!group) {
      group = {
        orm: report.orm,
        scenario: report.scenario,
        runs: 0,
        durationSeconds: 0,
        totalOperations: 0,
        totalErrors: 0,
        metrics: {},
      };
      groups.set(key, group);
    }

    group.runs += 1;
    group.durationSeconds += report.durationSeconds;
    group.totalOperations += report.totalOperations;
    group.totalErrors += report.totalErrors;

    for (const [metricName, metric] of Object.entries(report.metrics)) {
      let aggregate = group.metrics[metricName];

      if (!aggregate) {
        aggregate = {
          count: 0,
          errors: 0,
          averageMsTotal: 0,
          p50MsTotal: 0,
          p95MsTotal: 0,
          p99MsTotal: 0,
          lastError: undefined,
        };
        group.metrics[metricName] = aggregate;
      }

      aggregate.count += metric.count;
      aggregate.errors += metric.errors;
      aggregate.averageMsTotal += metric.averageMs;
      aggregate.p50MsTotal += metric.p50Ms;
      aggregate.p95MsTotal += metric.p95Ms;
      aggregate.p99MsTotal += metric.p99Ms;
      aggregate.lastError ??= metric.lastError;
    }
  }

  return Array.from(groups.values()).map((group) => ({
    orm: group.orm,
    scenario: group.scenario,
    runs: group.runs,
    durationSeconds: round(group.durationSeconds, 3),
    operationsPerSecond: round(group.totalOperations / group.durationSeconds, 2),
    totalOperations: group.totalOperations,
    totalErrors: group.totalErrors,
    metrics: Object.fromEntries(Object.entries(group.metrics).map(([metricName, metric]) => [metricName, {
      count: metric.count,
      errors: metric.errors,
      averageMs: round(metric.averageMsTotal / group.runs, 3),
      p50Ms: round(metric.p50MsTotal / group.runs, 3),
      p95Ms: round(metric.p95MsTotal / group.runs, 3),
      p99Ms: round(metric.p99MsTotal / group.runs, 3),
      lastError: metric.lastError,
    }])),
  }));
}

function selectedScenarios(options) {
  return options.scenario === "all" ? ["read-heavy", "write-and-read"] : [options.scenario];
}

function parseArgs(args) {
  const options = {
    durationSeconds: DEFAULT_DURATION_SECONDS,
    virtualUsers: DEFAULT_VIRTUAL_USERS,
    poolSize: DEFAULT_POOL_SIZE,
    seedRows: DEFAULT_SEED_ROWS,
    repeat: DEFAULT_REPEAT,
    scenario: "all",
    orms: ["npa", "prisma", "typeorm"],
    pgUrl: undefined,
    allowDestructive: false,
    skipPrismaGenerate: false,
    json: false,
    verbose: false,
  };
  const validOrms = new Set(["npa", "prisma", "typeorm"]);
  const validScenarios = new Set(["all", "read-heavy", "write-and-read"]);

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--allow-destructive") {
      options.allowDestructive = true;
    } else if (arg === "--skip-prisma-generate") {
      options.skipPrismaGenerate = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg.startsWith("--duration=")) {
      options.durationSeconds = positiveInteger(arg, "--duration");
    } else if (arg.startsWith("--virtual-users=")) {
      options.virtualUsers = positiveInteger(arg, "--virtual-users");
    } else if (arg.startsWith("--vus=")) {
      options.virtualUsers = positiveInteger(arg, "--vus");
    } else if (arg.startsWith("--pool-size=")) {
      options.poolSize = positiveInteger(arg, "--pool-size");
    } else if (arg.startsWith("--seed-rows=")) {
      options.seedRows = positiveInteger(arg, "--seed-rows");
    } else if (arg.startsWith("--repeat=")) {
      options.repeat = positiveInteger(arg, "--repeat");
    } else if (arg.startsWith("--scenario=")) {
      options.scenario = arg.slice("--scenario=".length);
    } else if (arg.startsWith("--orms=")) {
      options.orms = arg.slice("--orms=".length).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg.startsWith("--pg-url=")) {
      options.pgUrl = arg.slice("--pg-url=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown comparison benchmark option: ${arg}`);
    }
  }

  if (!validScenarios.has(options.scenario)) {
    throw new Error(`Unknown benchmark scenario: ${options.scenario}`);
  }

  if (options.orms.length === 0) {
    throw new Error("--orms must include at least one ORM lane.");
  }

  for (const orm of options.orms) {
    if (!validOrms.has(orm)) {
      throw new Error(`Unknown ORM lane: ${orm}`);
    }
  }

  return options;
}

function printReport(reports, skipped, options) {
  console.log("# NPA ORM Comparison Benchmark Report");
  console.log("\n## Test Environment");
  console.log("- Database: PostgreSQL");
  console.log(`- ORM lanes: ${options.orms.join(", ")}`);
  console.log(`- Connection pool: ${options.poolSize} connections per ORM`);
  console.log(`- Virtual Users: ${options.virtualUsers} concurrent workers`);
  console.log(`- Test Duration: ${options.durationSeconds} seconds per ORM/scenario pair`);
  console.log(`- Repeats: ${options.repeat}`);
  console.log(`- Seed Rows: ${options.seedRows}`);
  console.log("- Execution: sequential ORM lanes, one PostgreSQL Testcontainer per ORM lane unless --pg-url is used");

  for (const scenario of ["Read-Heavy", "Write-and-Read"]) {
    const scenarioReports = reports.filter((report) => report.scenario === scenario);

    if (scenarioReports.length === 0) {
      continue;
    }

    console.log(`\n## ${scenario} Benchmark Results`);
    printTable(scenarioRows(scenario, scenarioReports));
  }

  if (skipped.length > 0) {
    console.log("\nSkipped:");
    for (const item of skipped) {
      console.log(`- ${item.name}: ${item.reason}`);
    }
  }
}

function scenarioRows(scenario, reports) {
  const headers = ["Metric", ...reports.map((report) => report.orm)];
  const rows = [headers];

  if (scenario === "Read-Heavy") {
    addMetricRows(rows, reports, "List Users");
    addMetricRows(rows, reports, "Get By ID");
    rows.push(["Runs", ...reports.map((report) => formatNumber(report.runs))]);
    rows.push(["Total Reads", ...reports.map((report) => formatNumber(report.totalOperations))]);
    rows.push(["Reads/second", ...reports.map((report) => `${formatNumber(report.operationsPerSecond)}/s`)]);
    rows.push(["Errors", ...reports.map((report) => formatNumber(report.totalErrors))]);
    return rows;
  }

  addMetricRows(rows, reports, "Create User");
  addMetricRows(rows, reports, "Get User");
  rows.push(["Runs", ...reports.map((report) => formatNumber(report.runs))]);
  rows.push(["Total Iterations", ...reports.map((report) => formatNumber(report.totalOperations))]);
  rows.push(["Iterations/second", ...reports.map((report) => `${formatNumber(report.operationsPerSecond)}/s`)]);
  rows.push(["Errors", ...reports.map((report) => formatNumber(report.totalErrors))]);
  return rows;
}

function addMetricRows(rows, reports, metricName) {
  rows.push([`${metricName} (avg)`, ...reports.map((report) => `${formatNumber(report.metrics[metricName].averageMs)}ms`)]);
  rows.push([`${metricName} (p95)`, ...reports.map((report) => `${formatNumber(report.metrics[metricName].p95Ms)}ms`)]);
}

function printTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));

  rows.forEach((row, index) => {
    const line = row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
    console.log(line);

    if (index === 0) {
      console.log(widths.map((width) => "-".repeat(width)).join("  "));
    }
  });
}

function sumMetricCounts(metrics) {
  let total = 0;
  for (const metric of metrics.values()) total += metric.count;
  return total;
}

function sumMetricErrors(metrics) {
  let total = 0;
  for (const metric of metrics.values()) total += metric.errors;
  return total;
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

function positiveInteger(arg, name) {
  const value = Number(arg.slice(name.length + 1));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function consume(value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    blackhole ^= value.length;
    return;
  }
  if (typeof value === "object") {
    blackhole ^= Object.keys(value).length;
    return;
  }
  if (typeof value === "number") {
    blackhole ^= value;
    return;
  }
  blackhole ^= String(value).length;
}

function isMissingContainerRuntimeError(error) {
  return error instanceof Error && /container runtime|docker/i.test(error.message);
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printHelp() {
  console.log(`Usage: node benchmarks/compare/compare.js [options]\n\nOptions:\n  --orms=a,b             ORM lanes: npa,prisma,typeorm. Default: npa,prisma,typeorm\n  --scenario=NAME        all, read-heavy, or write-and-read. Default: all\n  --duration=N           Load scenario duration in seconds. Default: ${DEFAULT_DURATION_SECONDS}\n  --virtual-users=N      Concurrent load workers. Alias: --vus. Default: ${DEFAULT_VIRTUAL_USERS}\n  --pool-size=N          PostgreSQL pool size per ORM. Default: ${DEFAULT_POOL_SIZE}\n  --seed-rows=N          Deterministic seed rows. Default: ${DEFAULT_SEED_ROWS}\n  --repeat=N             Sequential repetitions per ORM/scenario pair. Default: ${DEFAULT_REPEAT}\n  --pg-url=URL           Existing PostgreSQL URL. Requires --allow-destructive.\n  --allow-destructive    Allow dropping/recreating npa_compare_users on --pg-url.\n  --skip-prisma-generate Skip automatic Prisma Client generation.\n  --json                 Print machine-readable JSON.\n  --verbose              Show Prisma generate output.\n`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
