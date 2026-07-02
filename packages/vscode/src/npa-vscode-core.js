const ENTITY_FILE_PATTERN = /\.entity\.(ts|tsx)$/;
const QUERY_METHOD_PATTERN = /\b(?:abstract\s+)?((?:findOne|find|exists|count|delete)[A-Za-z0-9_]*By[A-Za-z0-9_]*)\s*\(/g;
const REPOSITORY_PATTERN = /(?:export\s+)?(?:(abstract)\s+)?(class|interface)\s+([A-Za-z_]\w*)\s+extends\s+NPARepository\s*<\s*([A-Za-z_]\w*)\s*,/g;
const QUERY_DECORATOR_DIAGNOSTIC_CODE = "npa-query-function-property";

function collectLanguageWorkspaceSchemaFromSources(sources) {
  return {
    entities: sources.flatMap((source) =>
      parseEntitySchemasFromText(source.text, source.filePath),
    ),
  };
}

function parseEntitySchemasFromText(source, filePath = "") {
  const entities = [];
  const entityPattern = /@Entity(?:\(([\s\S]*?)\))?\s*(?:export\s+)?class\s+([A-Za-z_]\w*)/g;
  let match;

  while ((match = entityPattern.exec(source)) !== null) {
    const className = match[2];
    const bodyStart = source.indexOf("{", match.index + match[0].length);
    const bodyEnd = bodyStart < 0 ? -1 : findMatching(source, bodyStart, "{", "}");

    if (bodyStart < 0 || bodyEnd < 0) {
      continue;
    }

    entities.push({
      className,
      filePath,
      properties: parseEntityProperties(source.slice(bodyStart + 1, bodyEnd)),
    });
  }

  return entities;
}

function parseEntityProperties(classBody) {
  const properties = [];
  const fieldPattern = /((?:\s*@(Id|Column|Version|OneToMany|ManyToOne|ManyToMany)(?:\([\s\S]*?\))?\s*)+)\s*(?:public\s+|protected\s+|private\s+|readonly\s+|declare\s+)*([A-Za-z_]\w*)[!?]?\s*:\s*([^;=\n]+)/g;
  let match;

  while ((match = fieldPattern.exec(classBody)) !== null) {
    const decorators = match[1];
    const propertyName = match[3];
    const type = match[4].trim();
    const relation = parseRelationProperty(decorators, propertyName);

    if (relation) {
      properties.push(relation);
      continue;
    }

    if (/@Id(?:\(|\s|$)/.test(decorators)) {
      properties.push({
        name: propertyName,
        kind: "ID",
        type,
      });
      continue;
    }

    if (/@(?:Column|Version)(?:\(|\s|$)/.test(decorators)) {
      properties.push({
        name: propertyName,
        kind: "COLUMN",
        type,
      });
    }
  }

  return properties;
}

function parseRelationProperty(decorators, propertyName) {
  const relation = /@(OneToMany|ManyToOne|ManyToMany)\s*\(\s*\(\s*\)\s*=>\s*([A-Za-z_]\w*)/.exec(decorators);

  if (!relation) {
    return undefined;
  }

  return {
    name: propertyName,
    kind: "RELATION",
    type: relation[2],
    target: relation[2],
    relationKind: toRelationKind(relation[1]),
  };
}

function toRelationKind(decoratorName) {
  if (decoratorName === "OneToMany") {
    return "ONE_TO_MANY";
  }

  if (decoratorName === "ManyToOne") {
    return "MANY_TO_ONE";
  }

  return "MANY_TO_MANY";
}

function findRepositoryContext(source, offset) {
  for (const repository of findRepositoryDeclarations(source)) {
    if (offset >= repository.bodyStart && offset <= repository.bodyEnd) {
      return repository;
    }
  }

  return undefined;
}

function findRepositoryDeclarations(source) {
  const repositories = [];
  let match;

  while ((match = REPOSITORY_PATTERN.exec(source)) !== null) {
    const bodyStart = source.indexOf("{", match.index + match[0].length);
    const bodyEnd = bodyStart < 0 ? -1 : findMatching(source, bodyStart, "{", "}");

    if (bodyStart < 0 || bodyEnd < 0) {
      continue;
    }

    repositories.push({
      repositoryName: match[3],
      entityName: match[4],
      bodyStart,
      bodyEnd,
    });
  }

  return repositories;
}

function getMethodPrefixAtOffset(source, offset) {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const beforeCursor = source.slice(lineStart, offset);
  const match = /(?:^|[\s;{])(?:abstract\s+)?([A-Za-z_]\w*)$/.exec(beforeCursor);

  return match?.[1] ?? "";
}

function findRepositoryMethodDeclarations(source) {
  const queryDecoratedMethods = findQueryDecoratedRepositoryMembers(source);

  return findRepositoryDeclarations(source).flatMap((repository) => {
    const body = source.slice(repository.bodyStart + 1, repository.bodyEnd);
    const methods = [];
    let match;

    while ((match = QUERY_METHOD_PATTERN.exec(body)) !== null) {
      const methodName = match[1];
      const start = repository.bodyStart + 1 + match.index + match[0].indexOf(methodName);

      if (queryDecoratedMethods.some((method) =>
        start >= method.nameStart && start < method.nameEnd,
      )) {
        continue;
      }

      methods.push({
        ...repository,
        methodName,
        start,
        end: start + methodName.length,
      });
    }

    return methods;
  });
}

function findQueryDecoratedRepositoryMembers(source) {
  return findRepositoryDeclarations(source).flatMap((repository) => {
    const members = [];
    const body = source.slice(repository.bodyStart + 1, repository.bodyEnd);
    const decoratorPattern = /@Query\s*\(/g;
    let match;

    while ((match = decoratorPattern.exec(body)) !== null) {
      const decoratorStart = repository.bodyStart + 1 + match.index;
      const parenStart = source.indexOf("(", decoratorStart + "@Query".length);
      const parenEnd = parenStart < 0 ? -1 : findMatching(source, parenStart, "(", ")");

      if (parenStart < 0 || parenEnd < 0 || parenEnd > repository.bodyEnd) {
        continue;
      }

      const queryString = parseFirstStringArgument(source, parenStart + 1, parenEnd);
      const member = parseQueryDecoratedMemberDeclaration(source, parenEnd + 1, repository.bodyEnd);

      if (!member) {
        continue;
      }

      members.push({
        ...repository,
        ...member,
        decoratorStart,
        decoratorEnd: parenEnd + 1,
        queryString,
      });
    }

    return members;
  });
}

function findQueryDecoratorDiagnostics(source) {
  return findQueryDecoratedRepositoryMembers(source)
    .filter((member) => !member.isFunctionProperty)
    .map((member) => ({
      ...member,
      code: QUERY_DECORATOR_DIAGNOSTIC_CODE,
      severity: "ERROR",
      message: "@Query methods must be declared as a decorated function property.",
      start: member.nameStart,
      end: member.nameEnd,
    }));
}

function findQueryParameterCompletionContext(source, offset) {
  for (const member of findQueryDecoratedRepositoryMembers(source)) {
    if (!member.queryString ||
      offset < member.queryString.contentStart ||
      offset > member.queryString.contentEnd) {
      continue;
    }

    const placeholder = getNamedParameterPrefixAtOffset(
      source,
      member.queryString.contentStart,
      offset,
    );

    if (!placeholder) {
      continue;
    }

    return {
      ...member,
      prefix: placeholder.prefix,
      replacementStart: placeholder.replacementStart,
      replacementEnd: offset,
    };
  }

  return undefined;
}

function parseQueryDecoratedMemberDeclaration(source, start, end) {
  const declarationStart = skipIgnorable(source, start, end);
  const text = source.slice(declarationStart, end);
  const propertyMatch = /^(?<prefix>(?:(?:public|protected|private|static|readonly|override|abstract|declare)\s+)*)(?<name>[A-Za-z_]\w*)[!?]?\s*:\s*\((?<parameters>[^)]*)\)\s*=>/.exec(text);

  if (propertyMatch?.groups) {
    const { prefix, name, parameters } = propertyMatch.groups;
    const nameStart = declarationStart + prefix.length;

    return {
      declarationStart,
      methodName: name,
      nameStart,
      nameEnd: nameStart + name.length,
      parameters: parseParameterList(parameters),
      isFunctionProperty: true,
    };
  }

  const methodMatch = /^(?<prefix>(?:(?:public|protected|private|static|override|abstract|declare|async)\s+)*)(?<name>[A-Za-z_]\w*)\s*\((?<parameters>[^)]*)\)/.exec(text);

  if (methodMatch?.groups) {
    const { prefix, name, parameters } = methodMatch.groups;
    const nameStart = declarationStart + prefix.length;

    return {
      declarationStart,
      methodName: name,
      nameStart,
      nameEnd: nameStart + name.length,
      parameters: parseParameterList(parameters),
      isFunctionProperty: false,
    };
  }

  return undefined;
}

function parseFirstStringArgument(source, start, end) {
  const stringStart = skipIgnorable(source, start, end);

  if (stringStart >= end || !isStringQuote(source[stringStart])) {
    return undefined;
  }

  const stringEnd = findStringLiteralEnd(source, stringStart);

  if (stringEnd < 0 || stringEnd > end) {
    return undefined;
  }

  return {
    start: stringStart,
    end: stringEnd + 1,
    contentStart: stringStart + 1,
    contentEnd: stringEnd,
    value: source.slice(stringStart + 1, stringEnd),
  };
}

function getNamedParameterPrefixAtOffset(source, contentStart, offset) {
  const beforeCursor = source.slice(contentStart, offset);
  const match = /:([A-Za-z_]\w*)?$/.exec(beforeCursor);

  if (!match) {
    return undefined;
  }

  const colonStart = offset - match[0].length;

  if (colonStart > contentStart && source[colonStart - 1] === ":") {
    return undefined;
  }

  return {
    prefix: match[1] ?? "",
    replacementStart: colonStart + 1,
  };
}

function parseParameterList(parametersText) {
  return splitTopLevel(parametersText, ",")
    .map((parameter) => parseParameter(parameter.trim()))
    .filter(Boolean);
}

function parseParameter(parameter) {
  if (!parameter) {
    return undefined;
  }

  const normalized = parameter
    .replace(/^\s*(?:public|protected|private|readonly)\s+/, "")
    .replace(/\s*=.*$/, "")
    .trim();
  const match = /^(?:\.\.\.)?([A-Za-z_$]\w*)\??\s*(?::\s*(.+))?$/.exec(normalized);

  if (!match || match[1] === "this") {
    return undefined;
  }

  return {
    name: match[1],
    type: match[2]?.trim(),
  };
}

function splitTopLevel(text, separator) {
  const parts = [];
  let start = 0;
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (isStringQuote(char)) {
      const stringEnd = findStringLiteralEnd(text, index);
      index = stringEnd < 0 ? text.length : stringEnd;
      continue;
    }

    if (char === "<") angleDepth += 1;
    if (char === ">" && angleDepth > 0) angleDepth -= 1;
    if (char === "(") parenDepth += 1;
    if (char === ")" && parenDepth > 0) parenDepth -= 1;
    if (char === "[") bracketDepth += 1;
    if (char === "]" && bracketDepth > 0) bracketDepth -= 1;
    if (char === "{") braceDepth += 1;
    if (char === "}" && braceDepth > 0) braceDepth -= 1;

    if (char === separator &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

function isEntityFile(filePath) {
  return ENTITY_FILE_PATTERN.test(filePath);
}

function findMatching(source, openIndex, open, close) {
  let depth = 0;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (isStringQuote(char)) {
      const stringEnd = findStringLiteralEnd(source, index);
      index = stringEnd < 0 ? source.length : stringEnd;
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index + 2);
      index = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }

    if (char === "/" && source[index + 1] === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd < 0 ? source.length : commentEnd + 1;
      continue;
    }

    if (char === open) {
      depth += 1;
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

function skipIgnorable(source, start, end) {
  let index = start;

  while (index < end) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }

    if (source[index] === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index + 2);
      index = lineEnd < 0 ? end : lineEnd + 1;
      continue;
    }

    if (source[index] === "/" && source[index + 1] === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd < 0 ? end : commentEnd + 2;
      continue;
    }

    break;
  }

  return index;
}

function isStringQuote(char) {
  return char === "'" || char === '"' || char === "`";
}

function findStringLiteralEnd(source, start) {
  const quote = source[start];

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (char === quote) {
      return index;
    }
  }

  return -1;
}

module.exports = {
  collectLanguageWorkspaceSchemaFromSources,
  findQueryDecoratedRepositoryMembers,
  findQueryDecoratorDiagnostics,
  findQueryParameterCompletionContext,
  findRepositoryContext,
  findRepositoryDeclarations,
  findRepositoryMethodDeclarations,
  getMethodPrefixAtOffset,
  isEntityFile,
  parseEntitySchemasFromText,
};
