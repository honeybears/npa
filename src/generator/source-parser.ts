import * as fs from "node:fs";
import * as path from "node:path";
import { ParsedEntitySource } from "./types";

export function discoverEntitySources(
  cwd: string,
  patterns: string[],
): ParsedEntitySource[] {
  const files = collectFiles(cwd).filter((file) =>
    patterns.some((pattern) => matchesGlob(file, path.resolve(cwd, pattern))),
  );

  return files.flatMap((file) => parseEntityFile(file));
}

export function parseEntityFile(filePath: string): ParsedEntitySource[] {
  const source = fs.readFileSync(filePath, "utf8");
  const entities: ParsedEntitySource[] = [];
  const entityPattern = /@Entity(?:\([\s\S]*?\))?\s*(?:export\s+)?class\s+([A-Za-z_]\w*)/g;
  let match: RegExpExecArray | null;

  while ((match = entityPattern.exec(source)) !== null) {
    const className = match[1];
    const bodyStart = source.indexOf("{", match.index + match[0].length);
    const bodyEnd = bodyStart < 0 ? -1 : findMatchingBrace(source, bodyStart);

    if (bodyStart < 0 || bodyEnd < 0) {
      continue;
    }

    const body = source.slice(bodyStart + 1, bodyEnd);
    const columns = parseColumns(body);

    if (columns.length === 0) {
      continue;
    }

    entities.push({ className, filePath, columns });
  }

  return entities;
}

function parseColumns(classBody: string) {
  const columns = [];
  const fieldPattern =
    /((?:\s*@(Id|Column|Version)(?:\([^)]*\))?\s*)+)\s*(?:public\s+|protected\s+|private\s+|readonly\s+)*([A-Za-z_]\w*)(?:[?!])?\s*:\s*([^=;]+)[=;]?/g;
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(classBody)) !== null) {
    const decorators = match[1];
    const propertyName = match[3];
    const type = match[4].trim();

    columns.push({
      propertyName,
      type,
      primary: /@Id(?:\(|\s|$)/.test(decorators),
    });
  }

  return columns;
}

function collectFiles(root: string): string[] {
  const result: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      result.push(...collectFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      result.push(entryPath);
    }
  }

  return result;
}

function matchesGlob(filePath: string, pattern: string): boolean {
  return globToRegExp(normalizePath(pattern)).test(normalizePath(filePath));
}

function globToRegExp(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`^${source}$`);
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;

  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
      continue;
    }

    if (source[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
