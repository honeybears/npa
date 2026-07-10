#!/usr/bin/env node
const DEFAULT_ITERATIONS = 50_000;
const DEFAULT_WARMUP = 5_000;
const DEFAULT_LIVE_ITERATIONS = 1_000;
const DEFAULT_LIVE_WARMUP = 100;
const DEFAULT_LOAD_DURATION_SECONDS = 10;
const DEFAULT_LOAD_VIRTUAL_USERS = 10;
const DEFAULT_LOAD_POOL_SIZE = 10;
const DEFAULT_LOAD_SEED_ROWS = 1_000;

let blackhole = 0;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const suites = [];
  const skipped = [];

  suites.push(...createNpaSuites(options));
  await addLivePostgresqlSuites(suites, skipped, options);
  await addLiveMysqlSuites(suites, skipped, options);
  addOptionalOrmComparisonNotes(skipped, options);

  if (suites.length === 0 && skipped.length === 0) {
    throw new Error("No benchmark suites selected.");
  }

  const results = [];
  const loadReports = [];

  try {
    for (const suite of suites) {
      const result = suite.measure
        ? await suite.measure()
        : await measure(suite, {
          iterations: suite.live ? options.liveIterations : options.iterations,
          warmup: suite.live ? options.liveWarmup : options.warmup,
        });

      if (result.kind === "load-report") {
        loadReports.push(result);
      } else {
        results.push(result);
      }
    }
  } finally {
    for (const suite of suites) {
      await suite.cleanup?.();
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ results, loadReports, skipped, blackhole }, null, 2));
    return;
  }

  printReport(results, skipped, options, loadReports);
}

function createNpaSuites(options) {
  if (!["npa", "postgresql", "mysql"].some((lane) => options.include.has(lane))) {
    return [];
  }

  const npa = require("../dist");
  const suites = [];

  if (options.include.has("npa")) {
    const queryMethod = require("../dist/query-method");
    const { createDerivedQueryRepository } = require(
      "../dist/repository/create-derived-query-repository.js",
    );
    const methods = [
      "findByEmail",
      "findByEmailOrNameContaining",
      "findTop10ByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc",
      "countDistinctByTeamNameIgnoreCase",
      "deleteByStatusIn",
    ];
    const parsed = methods.map((method) => npa.parseQueryMethod(method));
    const repository = createDerivedQueryRepository({}, (invocation) => invocation);

    suites.push(
      {
        name: "npa.parseQueryMethod",
        group: "npa-core",
        fn(index) {
          return npa.parseQueryMethod(methods[index % methods.length]);
        },
      },
      {
        name: "npa.assertNoDuplicateQueryPredicates",
        group: "npa-core",
        fn(index) {
          return queryMethod.assertNoDuplicateQueryPredicates(
            parsed[index % parsed.length],
          );
        },
      },
      {
        name: "npa.proxy + query dispatch",
        group: "npa-repository",
        fn(index) {
          return repository.findByEmailOrNameContaining(
            `missing${index}@example.com`,
            "kim",
          );
        },
      },
    );
  }

  if (options.include.has("postgresql")) {
    const pg = require("../packages/pg/dist/postgresql-query-compiler.js");
    const query = npa.parseQueryMethod(
      "findTop10ByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc",
    );

    suites.push({
      name: "npa-pg.compilePostgresqlQuery",
      group: "npa-adapter",
      fn(index) {
        return pg.compilePostgresqlQuery(
          {
            query,
            args: ["kim", 20 + (index % 10)],
          },
          {
            tableName: "users",
            columns: { createdAt: "created_at" },
          },
        );
      },
    });
  }

  if (options.include.has("mysql")) {
    const mysql = require("../packages/mysql/dist/mysql-query-compiler.js");
    const query = npa.parseQueryMethod("findByEmailOrNameContaining");

    suites.push({
      name: "npa-mysql.compileMysqlQuery",
      group: "npa-adapter",
      fn(index) {
        return mysql.compileMysqlQuery(
          {
            query,
            args: [`user${index % 100}@example.com`, "kim"],
          },
          { tableName: "users" },
        );
      },
    });
  }

  return suites;
}

async function addLivePostgresqlSuites(suites, skipped, options) {
  if (!options.live || !options.include.has("postgresql")) {
    return;
  }

  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (error) {
    skipped.push({ name: "npa-pg live query", reason: `pg is unavailable: ${error.message}` });
    return;
  }

  const target = await resolvePostgresqlLiveTarget(skipped, options);

  if (!target) {
    return;
  }

  const npaPg = require("../packages/pg/dist/create-postgresql-derived-query-repository.js");
  const tableName = uniqueTableName("pg");
  const table = quotePostgresqlIdentifier(tableName);
  const pool = new Pool({ connectionString: target.url, max: options.poolSize });
  const cleanup = once(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    await pool.end().catch(() => {});
    await target.cleanup?.().catch(() => {});
  });

  try {
    await setupPostgresqlBenchmarkTable(pool, table, options.seedRows);
  } catch (error) {
    await cleanup();
    throw error;
  }

  const repository = npaPg.createPostgresqlDerivedQueryRepository({}, {
    queryable: pool,
    tableName,
    primaryKey: "id",
  });

  suites.push({
    name: "npa-pg live findOneByEmail",
    group: "npa-live",
    live: true,
    async fn(index) {
      return repository.findOneByEmail(`user${(index % options.seedRows) + 1}@example.com`);
    },
    cleanup,
  });

  suites.push({
    name: "npa-pg load report",
    group: "npa-load",
    async measure() {
      return runLoadReport({
        adapter: "PostgreSQL",
        repository,
        options,
      });
    },
    cleanup,
  });
}

async function addLiveMysqlSuites(suites, skipped, options) {
  if (!options.live || !options.include.has("mysql")) {
    return;
  }

  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch (error) {
    skipped.push({ name: "npa-mysql live query", reason: `mysql2 is unavailable: ${error.message}` });
    return;
  }

  const target = await resolveMysqlLiveTarget(skipped, options);

  if (!target) {
    return;
  }

  const npaMysql = require("../packages/mysql/dist/create-mysql-derived-query-repository.js");
  const tableName = uniqueTableName("mysql");
  const table = quoteMysqlIdentifier(tableName);
  const pool = createMysqlPool(target.url, mysql, options.poolSize);
  const cleanup = once(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    await pool.end().catch(() => {});
    await target.cleanup?.().catch(() => {});
  });

  try {
    await waitForMysqlPool(pool);
    await setupMysqlBenchmarkTable(pool, table, options.seedRows);
  } catch (error) {
    await cleanup();
    throw error;
  }

  const repository = npaMysql.createMysqlDerivedQueryRepository({}, {
    queryable: pool,
    tableName,
    primaryKey: "id",
  });

  suites.push({
    name: "npa-mysql live findOneByEmail",
    group: "npa-live",
    live: true,
    async fn(index) {
      return repository.findOneByEmail(`user${(index % options.seedRows) + 1}@example.com`);
    },
    cleanup,
  });

  suites.push({
    name: "npa-mysql load report",
    group: "npa-load",
    async measure() {
      return runLoadReport({
        adapter: "MySQL",
        repository,
        options,
      });
    },
    cleanup,
  });
}

async function resolvePostgresqlLiveTarget(skipped, options) {
  const url = options.pgUrl ?? process.env.NPA_BENCH_PG_URL ?? process.env.DATABASE_URL;

  if (url) {
    return { url };
  }

  let PostgreSqlContainer;
  try {
    ({ PostgreSqlContainer } = require("@testcontainers/postgresql"));
  } catch (error) {
    skipped.push({ name: "npa-pg live query", reason: `@testcontainers/postgresql is unavailable: ${error.message}` });
    return null;
  }

  const image = process.env.NPA_BENCH_POSTGRESQL_IMAGE
    ?? process.env.NPA_E2E_POSTGRESQL_IMAGE
    ?? "postgres:16-alpine";

  try {
    const container = await new PostgreSqlContainer(image).start();
    return {
      url: container.getConnectionUri(),
      cleanup: () => container.stop(),
    };
  } catch (error) {
    if (isMissingContainerRuntimeError(error)) {
      skipped.push({ name: "npa-pg live query", reason: "No Docker/container runtime is available for Testcontainers." });
      return null;
    }

    throw error;
  }
}

async function resolveMysqlLiveTarget(skipped, options) {
  const url = options.mysqlUrl ?? process.env.NPA_BENCH_MYSQL_URL;

  if (url) {
    return { url };
  }

  let MySqlContainer;
  try {
    ({ MySqlContainer } = require("@testcontainers/mysql"));
  } catch (error) {
    skipped.push({ name: "npa-mysql live query", reason: `@testcontainers/mysql is unavailable: ${error.message}` });
    return null;
  }

  const image = process.env.NPA_BENCH_MYSQL_IMAGE
    ?? process.env.NPA_E2E_MYSQL_IMAGE
    ?? "mysql:8.0";

  try {
    const container = await new MySqlContainer(image).start();
    return {
      url: container.getConnectionUri(),
      cleanup: () => container.stop(),
    };
  } catch (error) {
    if (isMissingContainerRuntimeError(error)) {
      skipped.push({ name: "npa-mysql live query", reason: "No Docker/container runtime is available for Testcontainers." });
      return null;
    }

    throw error;
  }
}

function createMysqlPool(url, mysql, poolSize) {
  const parsed = new URL(url);

  return mysql.createPool({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    waitForConnections: true,
    connectionLimit: poolSize,
  });
}

async function setupPostgresqlBenchmarkTable(pool, table, seedRows) {
  await pool.query(`
    CREATE TABLE ${table} (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX ${table.slice(1, -1)}_name_idx ON ${table} (name)`);
  await pool.query(
    `INSERT INTO ${table} (email, name, age)
     SELECT 'user' || g || '@example.com', 'bench user ' || g, 20 + (g % 50)
     FROM generate_series(1, $1) AS g`,
    [seedRows],
  );
}

async function setupMysqlBenchmarkTable(pool, table, seedRows) {
  await pool.query(`
    CREATE TABLE ${table} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      age INT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX ${table.slice(1, -1)}_name_idx (name)
    )
  `);

  const rows = Array.from({ length: seedRows }, (_, index) => [
    `user${index + 1}@example.com`,
    `bench user ${index + 1}`,
    20 + (index % 50),
  ]);

  for (const chunk of chunks(rows, 500)) {
    await pool.query(
      `INSERT INTO ${table} (email, name, age) VALUES ?`,
      [chunk],
    );
  }
}

async function waitForMysqlPool(pool) {
  let lastError;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw lastError;
}

async function runLoadReport({ adapter, repository, options }) {
  const scenarios = [];

  if (options.scenario === "all" || options.scenario === "read-heavy") {
    scenarios.push(await runReadHeavyScenario({ repository, options }));
  }

  if (options.scenario === "all" || options.scenario === "write-and-read") {
    scenarios.push(await runWriteAndReadScenario({ repository, options, adapter }));
  }

  return {
    kind: "load-report",
    adapter,
    poolSize: options.poolSize,
    virtualUsers: options.virtualUsers,
    durationSeconds: options.loadDurationSeconds,
    seedRows: options.seedRows,
    scenarios,
  };
}

async function runReadHeavyScenario({ repository, options }) {
  const metrics = createScenarioMetrics(["List Users", "Get By ID"]);
  const startedAt = performance.now();
  const deadline = startedAt + options.loadDurationSeconds * 1000;

  await Promise.all(Array.from({ length: options.virtualUsers }, (_, vu) =>
    runUntilDeadline(deadline, async (iteration) => {
      await recordOperation(metrics, "List Users", () =>
        repository.findTop10ByNameContainingOrderByIdDesc("bench"),
      );
      await recordOperation(metrics, "Get By ID", () =>
        repository.findOneById(((iteration + vu) % options.seedRows) + 1),
      );
    }),
  ));

  const durationSeconds = (performance.now() - startedAt) / 1000;
  const totalReads = sumMetricCounts(metrics);

  return {
    name: "Read-Heavy",
    durationSeconds: round(durationSeconds, 3),
    operationsPerSecond: round(totalReads / durationSeconds, 2),
    totalOperations: totalReads,
    totalErrors: sumMetricErrors(metrics),
    metrics: summarizeMetrics(metrics),
  };
}

async function runWriteAndReadScenario({ repository, options, adapter }) {
  const metrics = createScenarioMetrics(["Create User", "Get User"]);
  const state = { sequence: 0 };
  const startedAt = performance.now();
  const deadline = startedAt + options.loadDurationSeconds * 1000;

  await Promise.all(Array.from({ length: options.virtualUsers }, (_, vu) =>
    runUntilDeadline(deadline, async () => {
      const sequence = state.sequence++;
      const created = await recordOperation(metrics, "Create User", () =>
        repository.insert({
          email: `write-${adapter.toLowerCase()}-${process.pid}-${vu}-${sequence}@example.com`,
          name: `write user ${sequence}`,
          age: 20 + (sequence % 50),
        }),
      );

      if (created && created.id !== undefined && created.id !== null) {
        await recordOperation(metrics, "Get User", () => repository.findOneById(created.id));
      }
    }),
  ));

  const durationSeconds = (performance.now() - startedAt) / 1000;
  const totalIterations = Math.min(
    metrics.get("Create User").count,
    metrics.get("Get User").count,
  );

  return {
    name: "Write-and-Read",
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
  return new Map(names.map((name) => [name, {
    count: 0,
    errors: 0,
    latenciesMs: [],
    lastError: undefined,
  }]));
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

function sumMetricCounts(metrics) {
  let total = 0;

  for (const metric of metrics.values()) {
    total += metric.count;
  }

  return total;
}

function sumMetricErrors(metrics) {
  let total = 0;

  for (const metric of metrics.values()) {
    total += metric.errors;
  }

  return total;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueTableName(adapter) {
  return `npa_bench_${adapter}_${process.pid}_${Date.now().toString(36)}`;
}

function quotePostgresqlIdentifier(identifier) {
  assertSafeIdentifier(identifier);
  return `"${identifier}"`;
}

function quoteMysqlIdentifier(identifier) {
  assertSafeIdentifier(identifier);
  return `\`${identifier}\``;
}

function assertSafeIdentifier(identifier) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
}

function chunks(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function once(fn) {
  let called = false;

  return async () => {
    if (called) {
      return;
    }

    called = true;
    await fn();
  };
}

function isMissingContainerRuntimeError(error) {
  return error instanceof Error && /container runtime|docker/i.test(error.message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addOptionalOrmComparisonNotes(skipped, options) {
  if (options.include.has("prisma")) {
    try {
      require.resolve("@prisma/client");
      skipped.push({
        name: "prisma comparison",
        reason: "@prisma/client is installed, but this repo has no generated Prisma schema/client for an apples-to-apples model benchmark.",
      });
    } catch {
      skipped.push({ name: "prisma comparison", reason: "Install and generate @prisma/client in a benchmark app to enable this lane." });
    }
  }

  if (options.include.has("typeorm")) {
    try {
      require.resolve("typeorm");
      skipped.push({
        name: "typeorm comparison",
        reason: "typeorm is installed, but this repo has no TypeORM Entity/DataSource fixture yet.",
      });
    } catch {
      skipped.push({ name: "typeorm comparison", reason: "Install typeorm and add a DataSource fixture to enable this lane." });
    }
  }
}

async function measure(suite, options) {
  for (let index = 0; index < options.warmup; index += 1) {
    consume(await suite.fn(index));
  }

  const latencies = new Float64Array(options.iterations);
  const totalStart = performance.now();

  for (let index = 0; index < options.iterations; index += 1) {
    const start = performance.now();
    consume(await suite.fn(index));
    latencies[index] = (performance.now() - start) * 1000;
  }

  const totalMs = performance.now() - totalStart;
  const sorted = Array.from(latencies).sort((left, right) => left - right);

  return {
    name: suite.name,
    group: suite.group,
    iterations: options.iterations,
    totalMs: round(totalMs, 3),
    opsPerSecond: round(options.iterations / (totalMs / 1000), 2),
    averageUs: round((totalMs * 1000) / options.iterations, 3),
    p50Us: round(percentile(sorted, 0.50), 3),
    p95Us: round(percentile(sorted, 0.95), 3),
    p99Us: round(percentile(sorted, 0.99), 3),
  };
}

function consume(value) {
  if (value === undefined || value === null) {
    return;
  }

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

function percentile(sorted, ratio) {
  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

function printReport(results, skipped, options, loadReports) {
  console.log("NPA benchmark");
  console.log(`iterations=${options.iterations}, warmup=${options.warmup}, liveIterations=${options.liveIterations}, live=${options.live}`);
  console.log("");

  if (results.length > 0) {
    const rows = [
      ["Benchmark", "Group", "Iterations", "Total ms", "Ops/s (TPS)", "Avg us", "P50 us", "P95 us", "P99 us"],
      ...results.map((result) => [
        result.name,
        result.group,
        String(result.iterations),
        formatNumber(result.totalMs),
        formatNumber(result.opsPerSecond),
        formatNumber(result.averageUs),
        formatNumber(result.p50Us),
        formatNumber(result.p95Us),
        formatNumber(result.p99Us),
      ]),
    ];

    printTable(rows);
  }

  if (loadReports.length > 0) {
    printLoadReports(loadReports, options);
  }

  if (skipped.length > 0) {
    console.log("\nSkipped:");
    for (const item of skipped) {
      console.log(`- ${item.name}: ${item.reason}`);
    }
  }
}

function printLoadReports(loadReports, options) {
  console.log("\n# NPA Performance Benchmark Report");
  console.log("\n## Test Environment");
  console.log(`- Database: ${loadReports.map((report) => report.adapter).join(", ")}`);
  console.log(`- Connection pool: ${options.poolSize} connections per adapter`);
  console.log(`- Virtual Users: ${options.virtualUsers} concurrent workers`);
  console.log(`- Test Duration: ${options.loadDurationSeconds} seconds per scenario and adapter`);
  console.log("- Framework: Node.js load runner through NPA repositories");

  for (const scenarioName of ["Read-Heavy", "Write-and-Read"]) {
    const reports = loadReports
      .map((report) => ({
        adapter: report.adapter,
        scenario: report.scenarios.find((scenario) => scenario.name === scenarioName),
      }))
      .filter((report) => report.scenario);

    if (reports.length === 0) {
      continue;
    }

    console.log(`\n## ${scenarioName} Benchmark Results`);
    printTable(loadScenarioRows(scenarioName, reports));
  }
}

function loadScenarioRows(scenarioName, reports) {
  const headers = ["Metric", ...reports.map((report) => report.adapter)];
  const rows = [headers];

  if (scenarioName === "Read-Heavy") {
    addMetricRows(rows, reports, "List Users");
    addMetricRows(rows, reports, "Get By ID");
    rows.push(["Total Reads", ...reports.map((report) => formatNumber(report.scenario.totalOperations))]);
    rows.push(["Reads/second", ...reports.map((report) => `${formatNumber(report.scenario.operationsPerSecond)}/s`)]);
    rows.push(["Errors", ...reports.map((report) => formatNumber(report.scenario.totalErrors))]);
    return rows;
  }

  addMetricRows(rows, reports, "Create User");
  addMetricRows(rows, reports, "Get User");
  rows.push(["Total Iterations", ...reports.map((report) => formatNumber(report.scenario.totalOperations))]);
  rows.push(["Iterations/second", ...reports.map((report) => `${formatNumber(report.scenario.operationsPerSecond)}/s`)]);
  rows.push(["Errors", ...reports.map((report) => formatNumber(report.scenario.totalErrors))]);
  return rows;
}

function addMetricRows(rows, reports, metricName) {
  rows.push([
    `${metricName} (avg)`,
    ...reports.map((report) => `${formatNumber(report.scenario.metrics[metricName].averageMs)}ms`),
  ]);
  rows.push([
    `${metricName} (p95)`,
    ...reports.map((report) => `${formatNumber(report.scenario.metrics[metricName].p95Ms)}ms`),
  ]);
}

function printTable(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );

  rows.forEach((row, index) => {
    const line = row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
    console.log(line);

    if (index === 0) {
      console.log(widths.map((width) => "-".repeat(width)).join("  "));
    }
  });
}

function parseArgs(args) {
  const options = {
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    liveIterations: DEFAULT_LIVE_ITERATIONS,
    liveWarmup: DEFAULT_LIVE_WARMUP,
    include: new Set(["npa", "postgresql", "mysql"]),
    live: false,
    json: false,
    loadDurationSeconds: DEFAULT_LOAD_DURATION_SECONDS,
    virtualUsers: DEFAULT_LOAD_VIRTUAL_USERS,
    poolSize: DEFAULT_LOAD_POOL_SIZE,
    seedRows: DEFAULT_LOAD_SEED_ROWS,
    scenario: "all",
  };

  const validIncludes = new Set(["npa", "postgresql", "mysql", "prisma", "typeorm"]);
  const validScenarios = new Set(["all", "read-heavy", "write-and-read"]);

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--live") {
      options.live = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--iterations=")) {
      options.iterations = positiveInteger(arg, "--iterations");
    } else if (arg.startsWith("--warmup=")) {
      options.warmup = positiveInteger(arg, "--warmup");
    } else if (arg.startsWith("--live-iterations=")) {
      options.liveIterations = positiveInteger(arg, "--live-iterations");
    } else if (arg.startsWith("--live-warmup=")) {
      options.liveWarmup = positiveInteger(arg, "--live-warmup");
    } else if (arg.startsWith("--duration=")) {
      options.loadDurationSeconds = positiveInteger(arg, "--duration");
    } else if (arg.startsWith("--load-duration=")) {
      options.loadDurationSeconds = positiveInteger(arg, "--load-duration");
    } else if (arg.startsWith("--virtual-users=")) {
      options.virtualUsers = positiveInteger(arg, "--virtual-users");
    } else if (arg.startsWith("--vus=")) {
      options.virtualUsers = positiveInteger(arg, "--vus");
    } else if (arg.startsWith("--pool-size=")) {
      options.poolSize = positiveInteger(arg, "--pool-size");
    } else if (arg.startsWith("--seed-rows=")) {
      options.seedRows = positiveInteger(arg, "--seed-rows");
    } else if (arg.startsWith("--scenario=")) {
      options.scenario = arg.slice("--scenario=".length);
    } else if (arg.startsWith("--include=")) {
      options.include = new Set(arg.slice("--include=".length).split(",").map((item) => item.trim()).filter(Boolean));
    } else if (arg.startsWith("--pg-url=")) {
      options.pgUrl = arg.slice("--pg-url=".length);
    } else if (arg.startsWith("--mysql-url=")) {
      options.mysqlUrl = arg.slice("--mysql-url=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown benchmark option: ${arg}`);
    }
  }

  for (const include of options.include) {
    if (!validIncludes.has(include)) {
      throw new Error(`Unknown benchmark include lane: ${include}`);
    }
  }

  if (!validScenarios.has(options.scenario)) {
    throw new Error(`Unknown benchmark scenario: ${options.scenario}`);
  }

  return options;
}

function positiveInteger(arg, name) {
  const value = Number(arg.slice(name.length + 1));

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function printHelp() {
  console.log(`Usage: node benchmarks/benchmark.js [options]\n\nOptions:\n  --iterations=N        Non-DB iterations. Default: ${DEFAULT_ITERATIONS}\n  --warmup=N            Non-DB warmup iterations. Default: ${DEFAULT_WARMUP}\n  --live                Include live DB benchmarks. Starts Testcontainers when URLs are not provided.\n  --live-iterations=N   Single-query live iterations. Default: ${DEFAULT_LIVE_ITERATIONS}\n  --live-warmup=N       Single-query live warmup iterations. Default: ${DEFAULT_LIVE_WARMUP}\n  --duration=N          Load scenario duration in seconds. Default: ${DEFAULT_LOAD_DURATION_SECONDS}\n  --virtual-users=N     Concurrent load workers. Alias: --vus. Default: ${DEFAULT_LOAD_VIRTUAL_USERS}\n  --pool-size=N         DB pool size per adapter. Default: ${DEFAULT_LOAD_POOL_SIZE}\n  --seed-rows=N         Seed rows for read-heavy queries. Default: ${DEFAULT_LOAD_SEED_ROWS}\n  --scenario=NAME       all, read-heavy, or write-and-read. Default: all\n  --include=a,b         Include lanes: npa,postgresql,mysql,prisma,typeorm.\n  --pg-url=URL          PostgreSQL URL. Defaults to NPA_BENCH_PG_URL, DATABASE_URL, or Testcontainers.\n  --mysql-url=URL       MySQL URL. Defaults to NPA_BENCH_MYSQL_URL or Testcontainers.\n  --json                Print machine-readable JSON.\n`);
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
