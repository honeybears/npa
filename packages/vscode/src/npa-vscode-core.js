const ENTITY_FILE_PATTERN = /\.entity\.(ts|tsx)$/;
const QUERY_METHOD_PATTERN = /\b(?:abstract\s+)?((?:findOne|find|exists|count|delete)[A-Za-z0-9_]*By[A-Za-z0-9_]*)\s*\(/g;
const REPOSITORY_PATTERN = /(?:export\s+)?(?:(abstract)\s+)?(class|interface)\s+([A-Za-z_]\w*)\s+extends\s+NPARepository\s*<\s*([A-Za-z_]\w*)\s*,/g;

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
  return findRepositoryDeclarations(source).flatMap((repository) => {
    const body = source.slice(repository.bodyStart + 1, repository.bodyEnd);
    const methods = [];
    let match;

    while ((match = QUERY_METHOD_PATTERN.exec(body)) !== null) {
      const methodName = match[1];
      const start = repository.bodyStart + 1 + match.index + match[0].indexOf(methodName);

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

function isEntityFile(filePath) {
  return ENTITY_FILE_PATTERN.test(filePath);
}

function findMatching(source, openIndex, open, close) {
  let depth = 0;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

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

module.exports = {
  collectLanguageWorkspaceSchemaFromSources,
  findRepositoryContext,
  findRepositoryDeclarations,
  findRepositoryMethodDeclarations,
  getMethodPrefixAtOffset,
  isEntityFile,
  parseEntitySchemasFromText,
};
