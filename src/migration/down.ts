import type { MigrationAdapterName } from "./types";

export function createDownMigrationStatements(
  adapter: MigrationAdapterName,
  statements: string[],
): string[] {
  return statements
    .map((statement) => invertMigrationStatement(adapter, statement))
    .reverse()
    .filter((statement): statement is string => !!statement);
}

function invertMigrationStatement(
  adapter: MigrationAdapterName,
  statement: string,
): string | undefined {
  const normalized = statement.trim().replace(/;+\s*$/, "");

  return (
    invertCreateTable(normalized) ??
    invertCreateIndex(adapter, normalized) ??
    invertAddColumn(normalized) ??
    invertRenameColumn(normalized) ??
    invertRenameTable(adapter, normalized) ??
    invertAddForeignKey(adapter, normalized)
  );
}

function invertCreateTable(statement: string): string | undefined {
  const match = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(.+?)\s*\(/is.exec(statement);

  return match ? `DROP TABLE IF EXISTS ${match[1].trim()}` : undefined;
}

function invertCreateIndex(
  adapter: MigrationAdapterName,
  statement: string,
): string | undefined {
  const match = /^CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(.+?)\s+ON\s+(.+?)\s*\(/is.exec(statement);

  if (!match) {
    return undefined;
  }

  const indexName = match[1].trim();
  const tableName = match[2].trim();

  return adapter === "mysql"
    ? `DROP INDEX ${indexName} ON ${tableName}`
    : `DROP INDEX IF EXISTS ${indexName}`;
}

function invertAddColumn(statement: string): string | undefined {
  const match = /^ALTER\s+TABLE\s+(.+?)\s+ADD\s+COLUMN\s+(.+?)\s+/is.exec(statement);

  return match
    ? `ALTER TABLE ${match[1].trim()} DROP COLUMN ${match[2].trim()}`
    : undefined;
}

function invertRenameColumn(statement: string): string | undefined {
  const match = /^ALTER\s+TABLE\s+(.+?)\s+RENAME\s+COLUMN\s+(.+?)\s+TO\s+(.+?)$/is.exec(statement);

  return match
    ? `ALTER TABLE ${match[1].trim()} RENAME COLUMN ${match[3].trim()} TO ${match[2].trim()}`
    : undefined;
}

function invertRenameTable(
  adapter: MigrationAdapterName,
  statement: string,
): string | undefined {
  if (adapter === "mysql") {
    const match = /^RENAME\s+TABLE\s+(.+?)\s+TO\s+(.+?)$/is.exec(statement);

    return match
      ? `RENAME TABLE ${match[2].trim()} TO ${match[1].trim()}`
      : undefined;
  }

  const match = /^ALTER\s+TABLE\s+(.+?)\s+RENAME\s+TO\s+(.+?)$/is.exec(statement);

  return match
    ? `ALTER TABLE ${replaceLastIdentifier(match[1].trim(), match[2].trim())} RENAME TO ${lastIdentifier(match[1].trim())}`
    : undefined;
}

function invertAddForeignKey(
  adapter: MigrationAdapterName,
  statement: string,
): string | undefined {
  const match = /^ALTER\s+TABLE\s+(.+?)\s+ADD\s+CONSTRAINT\s+(.+?)\s+FOREIGN\s+KEY\b/is.exec(statement);

  if (!match) {
    return undefined;
  }

  return adapter === "mysql"
    ? `ALTER TABLE ${match[1].trim()} DROP FOREIGN KEY ${match[2].trim()}`
    : `ALTER TABLE ${match[1].trim()} DROP CONSTRAINT ${match[2].trim()}`;
}

function lastIdentifier(value: string): string {
  return value.split(".").at(-1) ?? value;
}

function replaceLastIdentifier(value: string, replacement: string): string {
  const parts = value.split(".");
  parts[parts.length - 1] = replacement;
  return parts.join(".");
}
