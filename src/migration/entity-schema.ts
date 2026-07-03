import * as fs from "node:fs";
import * as path from "node:path";
import {
  MigrationGenerationStrategy,
  MigrationColumnSchema,
  MigrationEntitySchema,
  MigrationIndexSchema,
  MigrationReferentialAction,
  MigrationRelationKind,
  MigrationRelationSchema,
} from "./types";

interface DecoratorOptions {
  name?: string;
  schema?: string;
  type?: string;
  defaultValue?: string | number | boolean | null;
  generationStrategy?: MigrationGenerationStrategy;
  sequenceName?: string;
  nullable?: boolean;
  index?: boolean | string;
  unique?: boolean | string;
  columns?: string[];
  mappedBy?: string;
  joinColumn?: string;
  joinColumns?: string[];
  joinTable?: string;
  foreignKeyName?: string;
  onDelete?: MigrationReferentialAction;
  onUpdate?: MigrationReferentialAction;
  orphanRemoval?: boolean;
}

type FieldDecoratorName = "Id" | "Column" | "Version" | "CreatedAt" | "UpdatedAt";

export function discoverEntitySchemas(
  cwd: string,
  patterns: string[],
): MigrationEntitySchema[] {
  const files = collectFiles(cwd).filter((file) =>
    patterns.some((pattern) => matchesGlob(file, path.resolve(cwd, pattern))),
  );

  return files.flatMap((file) => parseEntitySchemas(file));
}

export function parseEntitySchemas(filePath: string): MigrationEntitySchema[] {
  const source = fs.readFileSync(filePath, "utf8");
  const entities: MigrationEntitySchema[] = [];
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
): MigrationColumnSchema[] {
  const columns: MigrationColumnSchema[] = [];
  const fieldPattern = createFieldPattern();
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(classBody)) !== null) {
    const decorators = match[1];

    if (!/@(?:Id|Column|Version|CreatedAt|UpdatedAt)(?:\(|\s|$)/.test(decorators)) {
      continue;
    }

    const propertyName = match[2];
    const tsType = match[3].trim();
    const primary = /@Id(?:\(|\s|$)/.test(decorators);
    const version = /@Version(?:\(|\s|$)/.test(decorators);
    const createdAt = /@CreatedAt(?:\(|\s|$)/.test(decorators);
    const updatedAt = /@UpdatedAt(?:\(|\s|$)/.test(decorators);
    const decoratorName = primary
      ? "Id"
      : version
        ? "Version"
        : createdAt
          ? "CreatedAt"
          : updatedAt
            ? "UpdatedAt"
            : "Column";
    const rawOptions = readDecoratorArguments(decorators, decoratorName);
    const options = parseDecoratorOptions(
      rawOptions,
      `@${decoratorName} for ${className}.${propertyName}`,
      [
        "name",
        "type",
        "default",
        "nullable",
        "index",
        "unique",
        "generationStrategy",
        "sequenceName",
      ],
    );

    columns.push({
      propertyName,
      columnName: options.name ?? toSnakeCase(propertyName),
      tsType,
      dbType: options.type,
      ...(options.defaultValue !== undefined
        ? { defaultValue: options.defaultValue }
        : {}),
      ...((createdAt || updatedAt) && options.defaultValue === undefined
        ? { defaultCurrentTimestamp: true }
        : {}),
      ...(options.generationStrategy
        ? { generationStrategy: options.generationStrategy }
        : {}),
      ...(options.sequenceName ? { sequenceName: options.sequenceName } : {}),
      nullable: primary || version ? false : options.nullable ?? false,
      primary,
      version,
      ...(createdAt ? { createdAt: true } : {}),
      ...(updatedAt ? { updatedAt: true } : {}),
    });
  }

  assertUniqueSchemaNames(
    columns,
    className,
    "column name",
    (column) => column.columnName,
    (column) => column.propertyName,
  );

  return columns;
}

function parseIndexes(
  source: string,
  entityDecoratorIndex: number,
  classBody: string,
  className: string,
  columns: MigrationColumnSchema[],
): MigrationIndexSchema[] {
  const columnByProperty = new Map(columns.map((column) => [column.propertyName, column]));
  const classDecorators = readLeadingClassDecorators(source, entityDecoratorIndex);
  rejectUniqueDecorator(classDecorators, className);
  rejectUniqueDecorator(classBody, className);

  const parsedIndexes = [
    ...parseClassIndexes(classDecorators, className, columnByProperty),
    ...parsePropertyIndexes(classBody, className, columnByProperty),
  ];

  assertUniqueSchemaNames(
    parsedIndexes,
    className,
    "index name",
    (index) => index.name,
    (index) => index.columns.join(","),
  );

  const indexes = new Map<string, MigrationIndexSchema>();

  for (const index of parsedIndexes) {
    indexes.set(indexKey(index), index);
  }

  return [...indexes.values()].sort(compareIndexes);
}

function parseClassIndexes(
  decorators: string,
  className: string,
  columnByProperty: Map<string, MigrationColumnSchema>,
): MigrationIndexSchema[] {
  return parseNamedDecoratorOptions(decorators, "Index", `@Index for ${className}`)
    .map((options) => classIndex(options, className, columnByProperty));
}

function parsePropertyIndexes(
  classBody: string,
  className: string,
  columnByProperty: Map<string, MigrationColumnSchema>,
): MigrationIndexSchema[] {
  const indexes: MigrationIndexSchema[] = [];
  const fieldPattern = createFieldPattern();
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(classBody)) !== null) {
    const decorators = match[1];
    const propertyName = match[2];
    const column = columnByProperty.get(propertyName);

    if (/@Index(?:\(|\s|$)/.test(decorators)) {
      throw new Error(`@Index for ${className}.${propertyName} can only be used on entity classes. Use @Column({ index: true }) or @Column({ unique: true }) for single-column indexes.`);
    }

    if (!column) {
      continue;
    }

    const columnDecorator = /@Id(?:\(|\s|$)/.test(decorators)
      ? "Id"
      : /@Version(?:\(|\s|$)/.test(decorators)
        ? "Version"
        : /@CreatedAt(?:\(|\s|$)/.test(decorators)
          ? "CreatedAt"
          : /@UpdatedAt(?:\(|\s|$)/.test(decorators)
            ? "UpdatedAt"
            : "Column";

    if (/@(?:Id|Column|Version|CreatedAt|UpdatedAt)(?:\(|\s|$)/.test(decorators)) {
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

  }

  return indexes;
}

function classIndex(
  options: DecoratorOptions,
  className: string,
  columnByProperty: Map<string, MigrationColumnSchema>,
): MigrationIndexSchema {
  if (!options.columns?.length) {
    throw new Error(`Class-level @Index for ${className} requires columns.`);
  }

  return {
    name: options.name,
    columns: options.columns.map((propertyName) => {
      const column = columnByProperty.get(propertyName);

      if (!column) {
        throw new Error(`@Index for ${className} references unknown column property ${propertyName}.`);
      }

      return column.columnName;
    }),
    unique: options.unique === true,
  };
}

function columnIndex(
  column: MigrationColumnSchema,
  value: boolean | string,
  unique: boolean,
): MigrationIndexSchema {
  return {
    name: typeof value === "string" ? value : undefined,
    columns: [column.columnName],
    unique,
  };
}

function parseRelations(
  classBody: string,
  className: string,
): MigrationRelationSchema[] {
  const relations: MigrationRelationSchema[] = [];
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
      joinColumns: relationOptions.joinColumns,
      joinTable: relationOptions.joinTable ?? relationOptions.name,
      foreignKeyName: relationOptions.foreignKeyName,
      onDelete: relationOptions.onDelete,
      onUpdate: relationOptions.onUpdate,
    });
    cursor = closeIndex + 1;
  }

  assertUniqueSchemaNames(
    relations,
    className,
    "relation property",
    (relation) => relation.propertyName,
    (relation) => relation.kind,
  );
  assertUniqueSchemaNames(
    relations,
    className,
    "relation foreign key name",
    (relation) => relation.foreignKeyName,
    (relation) => relation.propertyName,
  );

  return relations;
}

function findNextRelationDecorator(
  source: string,
  cursor: number,
): { decoratorName: string; kind: MigrationRelationKind; index: number } | undefined {
  const candidates: Array<{ decoratorName: string; kind: MigrationRelationKind; index: number }> = [
    {
      decoratorName: "OneToOne",
      kind: MigrationRelationKind.ONE_TO_ONE,
      index: source.indexOf("@OneToOne", cursor),
    },
    {
      decoratorName: "OneToMany",
      kind: MigrationRelationKind.ONE_TO_MANY,
      index: source.indexOf("@OneToMany", cursor),
    },
    {
      decoratorName: "ManyToOne",
      kind: MigrationRelationKind.MANY_TO_ONE,
      index: source.indexOf("@ManyToOne", cursor),
    },
    {
      decoratorName: "ManyToMany",
      kind: MigrationRelationKind.MANY_TO_MANY,
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
    "joinColumns",
    "joinTable",
    "foreignKeyName",
    "onDelete",
    "onUpdate",
    "cascade",
    "orphanRemoval",
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

    if (key === "nullable" || key === "orphanRemoval") {
      if (rawPropertyValue !== "true" && rawPropertyValue !== "false") {
        throw new Error(`${context}.${key} must be a boolean literal.`);
      }

      options[key] = rawPropertyValue === "true";
      continue;
    }

    if (key === "default") {
      options.defaultValue = readDefaultLiteral(rawPropertyValue, `${context}.${key}`);
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

    if (key === "joinColumns") {
      options.joinColumns = readStringArrayLiteral(rawPropertyValue, `${context}.${key}`);
      continue;
    }

    if (key === "onDelete" || key === "onUpdate") {
      options[key] = readReferentialActionOption(
        rawPropertyValue,
        `${context}.${key}`,
      );
      continue;
    }

    if (key === "generationStrategy") {
      options.generationStrategy = readGenerationStrategyOption(
        rawPropertyValue,
        `${context}.${key}`,
      );
      continue;
    }

    if (key === "cascade") {
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
    } else if (key === "sequenceName") {
      options.sequenceName = stringValue;
    }
  }

  return options;
}

function readGenerationStrategyOption(
  rawValue: string,
  context: string,
): MigrationGenerationStrategy {
  if (isStringLiteral(rawValue)) {
    return readGenerationStrategy(readStringLiteral(rawValue, context), context);
  }

  const enumMatch = /^(?:GenerationStrategy|MigrationGenerationStrategy)\.(AUTO_INCREMENT|SEQUENCE|UUID|NONE)$/.exec(
    rawValue,
  );

  if (enumMatch) {
    return readGenerationStrategy(enumMatch[1], context);
  }

  throw new Error(
    `${context} must be a string literal or GenerationStrategy enum member.`,
  );
}

function readGenerationStrategy(
  value: string,
  context: string,
): MigrationGenerationStrategy {
  switch (value) {
    case "AUTO_INCREMENT":
    case "SEQUENCE":
    case "UUID":
    case "NONE":
      return value;
    default:
      throw new Error(`${context} must be AUTO_INCREMENT, SEQUENCE, UUID, or NONE.`);
  }
}

function readDefaultLiteral(
  value: string,
  context: string,
): string | number | boolean | null {
  if (isStringLiteral(value)) {
    return readStringLiteral(value, context);
  }

  if (value === "true" || value === "false") {
    return value === "true";
  }

  if (value === "null") {
    return null;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  throw new Error(
    `${context} must be a string, number, boolean, or null literal.`,
  );
}

function readReferentialActionOption(
  rawValue: string,
  context: string,
): MigrationReferentialAction {
  if (isStringLiteral(rawValue)) {
    return readReferentialAction(readStringLiteral(rawValue, context), context);
  }

  const enumMatch = /^(?:ReferentialAction|MigrationReferentialAction)\.(CASCADE|SET_NULL|RESTRICT|NO_ACTION)$/.exec(
    rawValue,
  );

  if (enumMatch) {
    return readReferentialActionEnumMember(enumMatch[1], context);
  }

  throw new Error(
    `${context} must be a string literal or ReferentialAction enum member.`,
  );
}

function readReferentialActionEnumMember(
  memberName: string,
  context: string,
): MigrationReferentialAction {
  switch (memberName) {
    case "CASCADE":
      return MigrationReferentialAction.CASCADE;
    case "SET_NULL":
      return MigrationReferentialAction.SET_NULL;
    case "RESTRICT":
      return MigrationReferentialAction.RESTRICT;
    case "NO_ACTION":
      return MigrationReferentialAction.NO_ACTION;
    default:
      throw new Error(`${context} must be CASCADE, SET_NULL, RESTRICT, or NO_ACTION.`);
  }
}

function readReferentialAction(
  value: string,
  context: string,
): MigrationReferentialAction {
  switch (value) {
    case MigrationReferentialAction.CASCADE:
      return MigrationReferentialAction.CASCADE;
    case MigrationReferentialAction.SET_NULL:
      return MigrationReferentialAction.SET_NULL;
    case MigrationReferentialAction.RESTRICT:
      return MigrationReferentialAction.RESTRICT;
    case MigrationReferentialAction.NO_ACTION:
      return MigrationReferentialAction.NO_ACTION;
    default:
      throw new Error(`${context} must be CASCADE, SET NULL, RESTRICT, or NO ACTION.`);
  }
}

function parseNamedDecoratorOptions(
  decorators: string,
  name: "Index",
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

    options.push(...parseIndexDecoratorOptions(rawArguments, context));
    cursor = openIndex;
  }

  return options;
}

function parseIndexDecoratorOptions(
  rawValue: string | undefined,
  context: string,
): DecoratorOptions[] {
  if (rawValue === undefined || rawValue.trim() === "") {
    return [parseDecoratorOptions(rawValue, context, ["name", "columns", "unique"])];
  }

  const value = rawValue.trim();

  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();

    if (!body) {
      return [];
    }

    return splitTopLevel(body).map((entry, index) =>
      readIndexOptions(entry, `${context}[${index}]`),
    );
  }

  return [readIndexOptions(value, context)];
}

function readIndexOptions(value: string | undefined, context: string): DecoratorOptions {
  const options = parseDecoratorOptions(value, context, ["name", "columns", "unique"]);

  if (typeof options.unique === "string") {
    throw new Error(`${context}.unique must be a boolean literal.`);
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
  const beforeEntity = source.slice(0, entityDecoratorIndex);
  const match = /((?:\s*@\w+(?:\([\s\S]*?\))?\s*)+)$/.exec(beforeEntity);

  return match?.[1] ?? "";
}

function createFieldPattern(): RegExp {
  return /((?:\s*@(?:Id|Column|Version|CreatedAt|UpdatedAt|Index|Unique)(?:\((?:[^()"'`]|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)*\))?\s*)+)\s*(?:public\s+|protected\s+|private\s+|readonly\s+)*([A-Za-z_]\w*)(?:[?!])?\s*:\s*([^=;]+)[=;]?/g;
}

function rejectUniqueDecorator(source: string, className: string): void {
  if (/@Unique(?:\(|\s|$)/.test(source)) {
    throw new Error(`@Unique is not supported for ${className}. Use @Index({ unique: true }) for composite indexes or @Column({ unique: true }) for single-column indexes.`);
  }
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

function indexKey(index: MigrationIndexSchema): string {
  return `${index.unique ? "unique" : "index"}:${index.name ?? index.columns.join(",")}`;
}

function compareIndexes(left: MigrationIndexSchema, right: MigrationIndexSchema): number {
  return indexKey(left).localeCompare(indexKey(right));
}

function assertUniqueSchemaNames<T>(
  items: T[],
  className: string,
  label: string,
  nameOf: (item: T) => string | undefined,
  ownerOf: (item: T) => string,
): void {
  const seen = new Map<string, string>();

  for (const item of items) {
    const name = nameOf(item);

    if (!name) {
      continue;
    }

    const owner = ownerOf(item);
    const previous = seen.get(name);

    if (previous !== undefined) {
      throw new Error(
        `Duplicate ${label} "${name}" in ${className}: ${previous} and ${owner}.`,
      );
    }

    seen.set(name, owner);
  }
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
