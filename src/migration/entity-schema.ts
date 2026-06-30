import * as fs from "node:fs";
import * as path from "node:path";
import {
  NPAMigrationColumnSchema,
  NPAMigrationEntitySchema,
  NPAMigrationIndexSchema,
  NPAMigrationReferentialAction,
  NPAMigrationRelationKind,
  NPAMigrationRelationSchema,
} from "./types";

interface DecoratorOptions {
  name?: string;
  schema?: string;
  type?: string;
  nullable?: boolean;
  index?: boolean | string;
  unique?: boolean | string;
  columns?: string[];
  mappedBy?: string;
  joinColumn?: string;
  joinTable?: string;
  foreignKeyName?: string;
  onDelete?: NPAMigrationReferentialAction;
  onUpdate?: NPAMigrationReferentialAction;
}

type FieldDecoratorName = "Id" | "Column" | "Version" | "Index" | "Unique";

export function discoverEntitySchemas(
  cwd: string,
  patterns: string[],
): NPAMigrationEntitySchema[] {
  const files = collectFiles(cwd).filter((file) =>
    patterns.some((pattern) => matchesGlob(file, path.resolve(cwd, pattern))),
  );

  return files.flatMap((file) => parseEntitySchemas(file));
}

export function parseEntitySchemas(filePath: string): NPAMigrationEntitySchema[] {
  const source = fs.readFileSync(filePath, "utf8");
  const entities: NPAMigrationEntitySchema[] = [];
  const entityPattern = /@Entity(?:\(([\s\S]*?)\))?\s*(?:export\s+)?class\s+([A-Za-z_]\w*)/g;
  let match: RegExpExecArray | null;

  while ((match = entityPattern.exec(source)) !== null) {
    const entityOptions = parseDecoratorOptions(
      match[1],
      `@Entity for ${match[2]}`,
      ["name", "schema"],
    );
    const className = match[2];
    const bodyStart = source.indexOf("{", match.index + match[0].length);
    const bodyEnd = bodyStart < 0 ? -1 : findMatching(source, bodyStart, "{", "}");

    if (bodyStart < 0 || bodyEnd < 0) {
      continue;
    }

    const classBody = source.slice(bodyStart + 1, bodyEnd);
    const columns = parseColumns(classBody, className);

    if (columns.length === 0) {
      continue;
    }

    entities.push({
      className,
      filePath,
      tableName: entityOptions.name ?? toSnakeCase(className),
      schema: entityOptions.schema,
      columns,
      indexes: parseIndexes(source, match.index, classBody, className, columns),
      relations: parseRelations(classBody, className),
    });
  }

  return entities;
}

function parseColumns(
  classBody: string,
  className: string,
): NPAMigrationColumnSchema[] {
  const columns: NPAMigrationColumnSchema[] = [];
  const fieldPattern = createFieldPattern();
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(classBody)) !== null) {
    const decorators = match[1];

    if (!/@(?:Id|Column|Version)(?:\(|\s|$)/.test(decorators)) {
      continue;
    }

    const propertyName = match[2];
    const tsType = match[3].trim();
    const primary = /@Id(?:\(|\s|$)/.test(decorators);
    const version = /@Version(?:\(|\s|$)/.test(decorators);
    const decoratorName = primary ? "Id" : version ? "Version" : "Column";
    const rawOptions = readDecoratorArguments(decorators, decoratorName);
    const options = parseDecoratorOptions(
      rawOptions,
      `@${decoratorName} for ${className}.${propertyName}`,
      ["name", "type", "nullable", "index", "unique"],
    );

    columns.push({
      propertyName,
      columnName: options.name ?? toSnakeCase(propertyName),
      tsType,
      dbType: options.type,
      nullable: primary || version ? false : options.nullable ?? false,
      primary,
      version,
    });
  }

  return columns;
}

function parseIndexes(
  source: string,
  entityDecoratorIndex: number,
  classBody: string,
  className: string,
  columns: NPAMigrationColumnSchema[],
): NPAMigrationIndexSchema[] {
  const indexes = new Map<string, NPAMigrationIndexSchema>();
  const columnByProperty = new Map(columns.map((column) => [column.propertyName, column]));
  const classDecorators = readLeadingClassDecorators(source, entityDecoratorIndex);

  for (const index of parseClassIndexes(classDecorators, className, columnByProperty)) {
    indexes.set(indexKey(index), index);
  }

  for (const index of parsePropertyIndexes(classBody, className, columnByProperty)) {
    indexes.set(indexKey(index), index);
  }

  return [...indexes.values()].sort(compareIndexes);
}

function parseClassIndexes(
  decorators: string,
  className: string,
  columnByProperty: Map<string, NPAMigrationColumnSchema>,
): NPAMigrationIndexSchema[] {
  return [
    ...parseNamedDecoratorOptions(decorators, "Index", `@Index for ${className}`)
      .map((options) => classIndex(options, false, className, columnByProperty)),
    ...parseNamedDecoratorOptions(decorators, "Unique", `@Unique for ${className}`)
      .map((options) => classIndex(options, true, className, columnByProperty)),
  ];
}

function parsePropertyIndexes(
  classBody: string,
  className: string,
  columnByProperty: Map<string, NPAMigrationColumnSchema>,
): NPAMigrationIndexSchema[] {
  const indexes: NPAMigrationIndexSchema[] = [];
  const fieldPattern = createFieldPattern();
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(classBody)) !== null) {
    const decorators = match[1];
    const propertyName = match[2];
    const column = columnByProperty.get(propertyName);

    if (!column) {
      if (/@(?:Index|Unique)(?:\(|\s|$)/.test(decorators)) {
        throw new Error(`Index decorators for ${className}.${propertyName} must target a column property.`);
      }

      continue;
    }

    const columnDecorator = /@Id(?:\(|\s|$)/.test(decorators)
      ? "Id"
      : /@Version(?:\(|\s|$)/.test(decorators)
        ? "Version"
        : "Column";

    if (/@(?:Id|Column|Version)(?:\(|\s|$)/.test(decorators)) {
      const columnOptions = parseDecoratorOptions(
        readDecoratorArguments(decorators, columnDecorator),
        `@${columnDecorator} for ${className}.${propertyName}`,
        ["name", "type", "nullable", "index", "unique"],
      );

      if (columnOptions.index) {
        indexes.push(columnIndex(column, columnOptions.index, false));
      }

      if (columnOptions.unique) {
        indexes.push(columnIndex(column, columnOptions.unique, true));
      }
    }

    const indexOptions = readDecoratorArguments(decorators, "Index");

    if (indexOptions !== undefined || /@Index(?:\s|$)/.test(decorators)) {
      const options = parseDecoratorOptions(
        indexOptions,
        `@Index for ${className}.${propertyName}`,
        ["name"],
      );
      indexes.push({ name: options.name, columns: [column.columnName], unique: false });
    }

    const uniqueOptions = readDecoratorArguments(decorators, "Unique");

    if (uniqueOptions !== undefined || /@Unique(?:\s|$)/.test(decorators)) {
      const options = parseDecoratorOptions(
        uniqueOptions,
        `@Unique for ${className}.${propertyName}`,
        ["name"],
      );
      indexes.push({ name: options.name, columns: [column.columnName], unique: true });
    }
  }

  return indexes;
}

function classIndex(
  options: DecoratorOptions,
  unique: boolean,
  className: string,
  columnByProperty: Map<string, NPAMigrationColumnSchema>,
): NPAMigrationIndexSchema {
  if (!options.columns?.length) {
    throw new Error(`Class-level ${unique ? "@Unique" : "@Index"} for ${className} requires columns.`);
  }

  return {
    name: options.name,
    columns: options.columns.map((propertyName) => {
      const column = columnByProperty.get(propertyName);

      if (!column) {
        throw new Error(`${unique ? "@Unique" : "@Index"} for ${className} references unknown column property ${propertyName}.`);
      }

      return column.columnName;
    }),
    unique,
  };
}

function columnIndex(
  column: NPAMigrationColumnSchema,
  value: boolean | string,
  unique: boolean,
): NPAMigrationIndexSchema {
  return {
    name: typeof value === "string" ? value : undefined,
    columns: [column.columnName],
    unique,
  };
}

function parseRelations(
  classBody: string,
  className: string,
): NPAMigrationRelationSchema[] {
  const relations: NPAMigrationRelationSchema[] = [];
  let cursor = 0;

  while (cursor < classBody.length) {
    const match = findNextRelationDecorator(classBody, cursor);

    if (!match) {
      break;
    }

    const { decoratorName, kind, index: decoratorIndex } = match;
    const openIndex = skipWhitespace(classBody, decoratorIndex + decoratorName.length + 1);

    if (classBody[openIndex] !== "(") {
      throw new Error(`@${decoratorName} for ${className} must include decorator arguments.`);
    }

    const closeIndex = findMatching(classBody, openIndex, "(", ")");

    if (closeIndex < 0) {
      throw new Error(`@${decoratorName} for ${className} has unbalanced parentheses.`);
    }

    const rawArguments = classBody.slice(openIndex + 1, closeIndex);
    const propertyName = readDecoratedPropertyName(
      classBody,
      closeIndex + 1,
      `@${decoratorName} for ${className}`,
    );
    const targetClassName = readRelationTarget(
      rawArguments,
      `@${decoratorName} for ${className}.${propertyName}`,
    );
    const relationOptions = readRelationOptions(
      rawArguments,
      `@${decoratorName} for ${className}.${propertyName}`,
    );

    relations.push({
      propertyName,
      kind,
      targetClassName,
      mappedBy: relationOptions.mappedBy,
      joinColumn: relationOptions.joinColumn,
      joinTable: relationOptions.joinTable ?? relationOptions.name,
      foreignKeyName: relationOptions.foreignKeyName,
      onDelete: relationOptions.onDelete,
      onUpdate: relationOptions.onUpdate,
    });
    cursor = closeIndex + 1;
  }

  return relations;
}

function findNextRelationDecorator(
  source: string,
  cursor: number,
): { decoratorName: string; kind: NPAMigrationRelationKind; index: number } | undefined {
  const candidates: Array<{ decoratorName: string; kind: NPAMigrationRelationKind; index: number }> = [
    {
      decoratorName: "OneToMany",
      kind: "one-to-many" as const,
      index: source.indexOf("@OneToMany", cursor),
    },
    {
      decoratorName: "ManyToOne",
      kind: "many-to-one" as const,
      index: source.indexOf("@ManyToOne", cursor),
    },
    {
      decoratorName: "ManyToMany",
      kind: "many-to-many" as const,
      index: source.indexOf("@ManyToMany", cursor),
    },
  ].filter((candidate) => candidate.index >= 0);

  return candidates.sort((left, right) => left.index - right.index)[0];
}

function readRelationTarget(rawArguments: string, context: string): string {
  const targetArgument = splitTopLevel(rawArguments)[0];
  const targetMatch = /^\s*\(\s*\)\s*=>\s*([A-Za-z_]\w*)\s*$/.exec(
    targetArgument ?? "",
  );

  if (!targetMatch) {
    throw new Error(`${context} target must use a literal () => EntityClass expression.`);
  }

  return targetMatch[1];
}

function readRelationOptions(rawArguments: string, context: string): DecoratorOptions {
  const optionsArgument = splitTopLevel(rawArguments)[1];

  if (!optionsArgument) {
    return {};
  }

  return parseDecoratorOptions(optionsArgument, context, [
    "mappedBy",
    "inversedBy",
    "joinColumn",
    "joinTable",
    "foreignKeyName",
    "onDelete",
    "onUpdate",
  ]);
}

function readDecoratedPropertyName(
  source: string,
  startIndex: number,
  context: string,
): string {
  const propertyMatch = /^\s*(?:public\s+|protected\s+|private\s+|readonly\s+)*([A-Za-z_]\w*)(?:[?!])?\s*:/.exec(
    source.slice(startIndex),
  );

  if (!propertyMatch) {
    throw new Error(`${context} must be followed by a typed property.`);
  }

  return propertyMatch[1];
}

function parseDecoratorOptions(
  rawValue: string | undefined,
  context: string,
  supportedKeys: string[],
): DecoratorOptions {
  if (rawValue === undefined || rawValue.trim() === "") {
    return {};
  }

  const value = rawValue.trim();

  if (isStringLiteral(value)) {
    return { name: readStringLiteral(value, context) };
  }

  if (!value.startsWith("{") || !value.endsWith("}")) {
    throw new Error(
      `${context} must use a string literal or object literal for migration metadata.`,
    );
  }

  const options: DecoratorOptions = {};
  const body = value.slice(1, -1).trim();

  if (!body) {
    return options;
  }

  for (const entry of splitTopLevel(body)) {
    const separatorIndex = entry.indexOf(":");

    if (separatorIndex < 0) {
      throw new Error(`${context} contains unsupported object literal syntax.`);
    }

    const key = normalizeObjectKey(entry.slice(0, separatorIndex).trim());

    if (!supportedKeys.includes(key)) {
      continue;
    }

    const rawPropertyValue = entry.slice(separatorIndex + 1).trim();

    if (key === "nullable") {
      if (rawPropertyValue !== "true" && rawPropertyValue !== "false") {
        throw new Error(`${context}.${key} must be a boolean literal.`);
      }

      options.nullable = rawPropertyValue === "true";
      continue;
    }

    if (key === "index" || key === "unique") {
      if (rawPropertyValue === "true" || rawPropertyValue === "false") {
        options[key] = rawPropertyValue === "true";
        continue;
      }

      if (!isStringLiteral(rawPropertyValue)) {
        throw new Error(`${context}.${key} must be a boolean or string literal.`);
      }

      options[key] = readStringLiteral(rawPropertyValue, `${context}.${key}`);
      continue;
    }

    if (key === "columns") {
      options.columns = readStringArrayLiteral(rawPropertyValue, `${context}.${key}`);
      continue;
    }

    if (!isStringLiteral(rawPropertyValue)) {
      throw new Error(`${context}.${key} must be a string literal.`);
    }

    const stringValue = readStringLiteral(rawPropertyValue, `${context}.${key}`);

    if (key === "name") {
      options.name = stringValue;
    } else if (key === "schema") {
      options.schema = stringValue;
    } else if (key === "type") {
      options.type = stringValue;
    } else if (key === "joinTable") {
      options.joinTable = stringValue;
    } else if (key === "joinColumn") {
      options.joinColumn = stringValue;
    } else if (key === "mappedBy") {
      options.mappedBy = stringValue;
    } else if (key === "foreignKeyName") {
      options.foreignKeyName = stringValue;
    } else if (key === "onDelete") {
      options.onDelete = readReferentialAction(stringValue, `${context}.${key}`);
    } else if (key === "onUpdate") {
      options.onUpdate = readReferentialAction(stringValue, `${context}.${key}`);
    }
  }

  return options;
}

function readReferentialAction(
  value: string,
  context: string,
): NPAMigrationReferentialAction {
  if (
    value !== "CASCADE" &&
    value !== "SET NULL" &&
    value !== "RESTRICT" &&
    value !== "NO ACTION"
  ) {
    throw new Error(`${context} must be CASCADE, SET NULL, RESTRICT, or NO ACTION.`);
  }

  return value;
}

function parseNamedDecoratorOptions(
  decorators: string,
  name: "Index" | "Unique",
  context: string,
): DecoratorOptions[] {
  const options: DecoratorOptions[] = [];
  let cursor = 0;

  while (cursor < decorators.length) {
    const start = decorators.indexOf(`@${name}`, cursor);

    if (start < 0) {
      break;
    }

    const afterName = start + name.length + 1;

    if (/\w/.test(decorators[afterName] ?? "")) {
      cursor = afterName;
      continue;
    }

    let openIndex = skipWhitespace(decorators, afterName);
    let rawArguments: string | undefined;

    if (decorators[openIndex] === "(") {
      const closeIndex = findMatching(decorators, openIndex, "(", ")");

      if (closeIndex < 0) {
        throw new Error(`@${name} decorator has unbalanced parentheses.`);
      }

      rawArguments = decorators.slice(openIndex + 1, closeIndex);
      openIndex = closeIndex + 1;
    }

    options.push(parseDecoratorOptions(rawArguments, context, ["name", "columns"]));
    cursor = openIndex;
  }

  return options;
}

function readDecoratorArguments(
  decorators: string,
  name: FieldDecoratorName,
): string | undefined {
  const token = `@${name}`;
  const start = decorators.indexOf(token);

  if (start < 0) {
    return undefined;
  }

  let cursor = start + token.length;

  while (/\s/.test(decorators[cursor] ?? "")) {
    cursor += 1;
  }

  if (decorators[cursor] !== "(") {
    return undefined;
  }

  const end = findMatching(decorators, cursor, "(", ")");

  if (end < 0) {
    throw new Error(`@${name} decorator has unbalanced parentheses.`);
  }

  return decorators.slice(cursor + 1, end);
}

function readLeadingClassDecorators(source: string, entityDecoratorIndex: number): string {
  let start = source.lastIndexOf("\n", entityDecoratorIndex - 1) + 1;

  while (start > 0) {
    const previousLineEnd = start - 1;
    const previousLineStart = source.lastIndexOf("\n", previousLineEnd - 1) + 1;
    const previousLine = source.slice(previousLineStart, previousLineEnd).trim();

    if (!previousLine.startsWith("@")) {
      break;
    }

    start = previousLineStart;
  }

  return source.slice(start, entityDecoratorIndex);
}

function createFieldPattern(): RegExp {
  return /((?:\s*@(?:Id|Column|Version|Index|Unique)(?:\((?:[^()"'`]|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)*\))?\s*)+)\s*(?:public\s+|protected\s+|private\s+|readonly\s+)*([A-Za-z_]\w*)(?:[?!])?\s*:\s*([^=;]+)[=;]?/g;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | undefined;
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = undefined;
      }

      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }

    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      continue;
    }

    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function normalizeObjectKey(value: string): string {
  return isStringLiteral(value) ? readStringLiteral(value, "object key") : value;
}

function isStringLiteral(value: string): boolean {
  if (value.length < 2) {
    return false;
  }

  const quote = value[0];

  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return false;
  }

  if (value[value.length - 1] !== quote) {
    return false;
  }

  return quote !== "`" || !value.includes("${");
}

function readStringLiteral(value: string, context: string): string {
  if (!isStringLiteral(value)) {
    throw new Error(`${context} must be a string literal.`);
  }

  const quote = value[0];
  const body = value.slice(1, -1);

  return body
    .replace(new RegExp(`\\${quote}`, "g"), quote)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function readStringArrayLiteral(value: string, context: string): string[] {
  const trimmed = value.trim();

  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`${context} must be an array of string literals.`);
  }

  const body = trimmed.slice(1, -1).trim();

  if (!body) {
    return [];
  }

  return splitTopLevel(body).map((entry) => readStringLiteral(entry, context));
}

function indexKey(index: NPAMigrationIndexSchema): string {
  return `${index.unique ? "unique" : "index"}:${index.name ?? index.columns.join(",")}`;
}

function compareIndexes(left: NPAMigrationIndexSchema, right: NPAMigrationIndexSchema): number {
  return indexKey(left).localeCompare(indexKey(right));
}

function collectFiles(root: string): string[] {
  const result: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
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

function findMatching(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = undefined;
      }

      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === open) {
      depth += 1;
      continue;
    }

    if (char === close) {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function skipWhitespace(source: string, startIndex: number): number {
  let cursor = startIndex;

  while (/\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }

  return cursor;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match, index) =>
    `${index === 0 ? "" : "_"}${match.toLowerCase()}`,
  );
}
