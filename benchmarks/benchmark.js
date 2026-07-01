#!/usr/bin/env node
const DEFAULT_ITERATIONS = 50_000;
const DEFAULT_WARMUP = 5_000;
const DEFAULT_LIVE_ITERATIONS = 1_000;
const DEFAULT_LIVE_WARMUP = 100;

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

  try {
    for (const suite of suites) {
      const iterations = suite.live ? options.liveIterations : options.iterations;
      const warmup = suite.live ? options.liveWarmup : options.warmup;
      const result = await measure(suite, { iterations, warmup });
      results.push(result);
    }
  } finally {
    for (const suite of suites) {
      await suite.cleanup?.();
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ results, skipped, blackhole }, null, 2));
    return;
  }

  printReport(results, skipped, options);
}

function createNpaSuites(options) {
  if (!["npa", "postgresql", "mysql"].some((lane) => options.include.has(lane))) {
    return [];
  }

  const npa = require("../dist");
  const suites = [];

  if (options.include.has("npa")) {
    const methods = [
      "findByEmail",
      "findByEmailOrNameContaining",
      "findTop10ByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc",
      "countDistinctByTeamNameIgnoreCase",
      "deleteByStatusIn",
    ];
    const parsed = methods.map((method) => npa.parseQueryMethod(method));
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      email: `user${index}@example.com`,
      name: index % 2 === 0 ? `kim ${index}` : `lee ${index}`,
      age: 20 + (index % 50),
      status: index % 3 === 0 ? "blocked" : "active",
      createdAt: index,
    }));
    const executor = new npa.InMemoryRepositoryExecutor(rows);
    const repository = npa.createDerivedQueryRepository({}, executor.execute);

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
          return npa.assertNoDuplicateQueryPredicates(parsed[index % parsed.length]);
        },
      },
      {
        name: "npa.proxy + in-memory find",
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
    const pg = require("../packages/pg/dist");
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
    const mysql = require("../packages/mysql/dist");
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

  const url = options.pgUrl ?? process.env.NPA_BENCH_PG_URL ?? process.env.DATABASE_URL;

  if (!url) {
    skipped.push({ name: "npa-pg live query", reason: "Set NPA_BENCH_PG_URL or DATABASE_URL." });
    return;
  }

  let Client;
  try {
    ({ Client } = require("pg"));
  } catch (error) {
    skipped.push({ name: "npa-pg live query", reason: `pg is unavailable: ${error.message}` });
    return;
  }

  const npaPg = require("../packages/pg/dist");
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("CREATE TEMP TABLE npa_bench_users (id SERIAL PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, age INTEGER NOT NULL)");
  await client.query(
    "INSERT INTO npa_bench_users (email, name, age) SELECT 'user' || g || '@example.com', 'kim ' || g, 20 + (g % 50) FROM generate_series(1, 100) AS g",
  );
  const repository = npaPg.createPostgresqlDerivedQueryRepository({}, {
    queryable: client,
    tableName: "npa_bench_users",
    primaryKey: "id",
  });

  suites.push({
    name: "npa-pg live findOneByEmail",
    group: "npa-live",
    live: true,
    async fn(index) {
      return repository.findOneByEmail(`user${(index % 100) + 1}@example.com`);
    },
    async cleanup() {
      await client.end();
    },
  });
}

async function addLiveMysqlSuites(suites, skipped, options) {
  if (!options.live || !options.include.has("mysql")) {
    return;
  }

  const url = options.mysqlUrl ?? process.env.NPA_BENCH_MYSQL_URL;

  if (!url) {
    skipped.push({ name: "npa-mysql live query", reason: "Set NPA_BENCH_MYSQL_URL." });
    return;
  }

  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch (error) {
    skipped.push({ name: "npa-mysql live query", reason: `mysql2 is unavailable: ${error.message}` });
    return;
  }

  const npaMysql = require("../packages/mysql/dist");
  const connection = await mysql.createConnection(url);
  await connection.query("CREATE TEMPORARY TABLE npa_bench_users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, age INT NOT NULL)");
  const rows = Array.from({ length: 100 }, (_, index) => [
    `user${index + 1}@example.com`,
    `kim ${index + 1}`,
    20 + (index % 50),
  ]);
  await connection.query(
    "INSERT INTO npa_bench_users (email, name, age) VALUES ?",
    [rows],
  );
  const repository = npaMysql.createMysqlDerivedQueryRepository({}, {
    queryable: connection,
    tableName: "npa_bench_users",
    primaryKey: "id",
  });

  suites.push({
    name: "npa-mysql live findOneByEmail",
    group: "npa-live",
    live: true,
    async fn(index) {
      return repository.findOneByEmail(`user${(index % 100) + 1}@example.com`);
    },
    async cleanup() {
      await connection.end();
    },
  });
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

function printReport(results, skipped, options) {
  console.log("NPA benchmark");
  console.log(`iterations=${options.iterations}, warmup=${options.warmup}, liveIterations=${options.liveIterations}, live=${options.live}`);
  console.log("");

  const rows = [
    ["Benchmark", "Group", "Iterations", "Total ms", "Ops/s", "Avg us", "P50 us", "P95 us", "P99 us"],
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

  if (skipped.length > 0) {
    console.log("\nSkipped:");
    for (const item of skipped) {
      console.log(`- ${item.name}: ${item.reason}`);
    }
  }
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
  };

  const validIncludes = new Set(["npa", "postgresql", "mysql", "prisma", "typeorm"]);

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
  console.log(`Usage: node benchmarks/benchmark.js [options]\n\nOptions:\n  --iterations=N        Non-DB iterations. Default: ${DEFAULT_ITERATIONS}\n  --warmup=N            Non-DB warmup iterations. Default: ${DEFAULT_WARMUP}\n  --live                Include live DB benchmarks when URLs are provided.\n  --live-iterations=N   Live DB iterations. Default: ${DEFAULT_LIVE_ITERATIONS}\n  --live-warmup=N       Live DB warmup iterations. Default: ${DEFAULT_LIVE_WARMUP}\n  --include=a,b         Include lanes: npa,postgresql,mysql,prisma,typeorm.\n  --pg-url=URL          PostgreSQL URL. Defaults to NPA_BENCH_PG_URL or DATABASE_URL.\n  --mysql-url=URL       MySQL URL. Defaults to NPA_BENCH_MYSQL_URL.\n  --json                Print machine-readable JSON.\n`);
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
