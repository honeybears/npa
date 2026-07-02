import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MigrationFile } from "./types";

const MIGRATION_FILE_NAME = "migration.sql";
const DOWN_MIGRATION_FILE_NAME = "down.sql";

export function createMigrationChecksumFromSql(sql: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeSqlForChecksum(sql))
    .digest("hex");
}

export function formatMigrationSql(statements: string[]): string {
  const sql = statements
    .map((statement) => statement.trim().replace(/;+\s*$/, ""))
    .filter(Boolean)
    .map((statement) => `${statement};`)
    .join("\n\n");

  return sql ? `${sql}\n` : "";
}

export function splitMigrationSql(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function loadMigrationFiles(
  cwd: string,
  migrationsDir: string,
): MigrationFile[] {
  const root = path.resolve(cwd, migrationsDir);

  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const filePath = path.join(root, entry.name, MIGRATION_FILE_NAME);

      if (!fs.existsSync(filePath)) {
        return undefined;
      }

      return readMigrationFile(entry.name, filePath);
    })
    .filter((migration): migration is MigrationFile => !!migration)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function writeMigrationFile(
  cwd: string,
  migrationsDir: string,
  migrationName: string | undefined,
  statements: string[],
  options: { downStatements?: string[] } = {},
): MigrationFile {
  const root = path.resolve(cwd, migrationsDir);
  const directoryName = createMigrationDirectoryName(root, migrationName);
  const directoryPath = path.join(root, directoryName);
  const filePath = path.join(directoryPath, MIGRATION_FILE_NAME);
  const downFilePath = path.join(directoryPath, DOWN_MIGRATION_FILE_NAME);
  const sql = formatMigrationSql(statements);
  const parsedStatements = splitMigrationSql(sql);
  const downSql = formatMigrationSql(options.downStatements ?? []);
  const downStatements = splitMigrationSql(downSql);

  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(filePath, sql, "utf8");

  if (downSql) {
    fs.writeFileSync(downFilePath, downSql, "utf8");
  }

  return {
    name: directoryName,
    checksum: createMigrationChecksumFromSql(sql),
    statements: parsedStatements,
    statementCount: parsedStatements.length,
    downStatements,
    downStatementCount: downStatements.length,
    filePath,
    ...(downSql ? { downFilePath } : {}),
  };
}

function readMigrationFile(name: string, filePath: string): MigrationFile {
  const sql = fs.readFileSync(filePath, "utf8");
  const statements = splitMigrationSql(sql);
  const downFilePath = path.join(path.dirname(filePath), DOWN_MIGRATION_FILE_NAME);
  const downSql = fs.existsSync(downFilePath)
    ? fs.readFileSync(downFilePath, "utf8")
    : "";
  const downStatements = splitMigrationSql(downSql);

  return {
    name,
    checksum: createMigrationChecksumFromSql(sql),
    statements,
    statementCount: statements.length,
    downStatements,
    downStatementCount: downStatements.length,
    filePath,
    ...(downSql ? { downFilePath } : {}),
  };
}

function createMigrationDirectoryName(
  migrationsRoot: string,
  migrationName: string | undefined,
): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = sanitizeMigrationName(migrationName ?? "migration");
  const baseName = `${timestamp}_${suffix}`;
  let directoryName = baseName;
  let attempt = 2;

  while (fs.existsSync(path.join(migrationsRoot, directoryName))) {
    directoryName = `${baseName}_${attempt}`;
    attempt += 1;
  }

  return directoryName;
}

function sanitizeMigrationName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "migration";
}

function normalizeSqlForChecksum(sql: string): string {
  const normalized = sql.replace(/\r\n/g, "\n").trim();

  return normalized ? `${normalized}\n` : "";
}
