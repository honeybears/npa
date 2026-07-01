import {
  ParsedQueryMethod,
  QueryCondition,
  QueryLogicalOperator,
  QueryMethodAction,
  QueryOperator,
  QueryOrder,
  QueryPredicatePart,
} from "./types";

interface ActionMatch {
  action: QueryMethodAction;
  rest: string;
  limit?: number;
}

interface SubjectMatch {
  distinct?: boolean;
  limit?: number;
}

interface OperatorDefinition {
  suffix: string;
  operator: QueryOperator;
  parameterCount: number;
}

const ACTION_PREFIXES: Array<[prefix: string, action: QueryMethodAction]> = [
  ["findOne", "findOne"],
  ["find", "find"],
  ["exists", "exists"],
  ["count", "count"],
  ["delete", "delete"],
];

const OPERATORS: OperatorDefinition[] = [
  ["IsNotNull", "isNotNull", 0],
  ["NotNull", "isNotNull", 0],
  ["LessThanEqual", "lessThanEqual", 1],
  ["GreaterThanEqual", "greaterThanEqual", 1],
  ["StartingWith", "startingWith", 1],
  ["EndingWith", "endingWith", 1],
  ["Containing", "containing", 1],
  ["LessThan", "lessThan", 1],
  ["GreaterThan", "greaterThan", 1],
  ["Between", "between", 2],
  ["IsNull", "isNull", 0],
  ["NotIn", "notIn", 1],
  ["Equals", "equals", 1],
  ["Equal", "equals", 1],
  ["False", "false", 0],
  ["True", "true", 0],
  ["Like", "like", 1],
  ["Not", "not", 1],
  ["In", "in", 1],
  ["Is", "equals", 1],
].map(([suffix, operator, parameterCount]) => ({
  suffix: suffix as string,
  operator: operator as QueryOperator,
  parameterCount: parameterCount as number,
}));

export function parseQueryMethod(methodName: string): ParsedQueryMethod {
  const actionMatch = parseAction(methodName);
  const byIndex = actionMatch.rest.indexOf("By");

  if (byIndex < 0) {
    throw new Error(`Query method "${methodName}" must include "By".`);
  }

  const subject = actionMatch.rest.slice(0, byIndex);
  const predicateAndOrder = actionMatch.rest.slice(byIndex + 2);
  const subjectMatch = parseSubject(subject, actionMatch.limit);
  const { predicateSource, orderBySource } = splitOrderBy(predicateAndOrder);
  const predicateMatch = stripAllIgnoreCase(predicateSource);
  const predicate = parsePredicate(predicateMatch.source);
  const orderBy = parseOrderBy(orderBySource);
  const parameterCount = predicate.reduce(
    (sum, part) => sum + getParameterCount(part.condition.operator),
    0,
  );

  return {
    methodName,
    action: actionMatch.action,
    ...(subjectMatch.distinct ? { distinct: true } : {}),
    ...(predicateMatch.allIgnoreCase ? { allIgnoreCase: true } : {}),
    limit: subjectMatch.limit,
    predicate,
    orderBy,
    parameterCount,
  };
}

function parseAction(methodName: string): ActionMatch {
  for (const [prefix, action] of ACTION_PREFIXES) {
    if (methodName.startsWith(prefix)) {
      return parseActionLimit(action, methodName.slice(prefix.length));
    }
  }

  throw new Error(
    `Unsupported query method "${methodName}". Use find, findOne, exists, count, or delete.`,
  );
}

function parseActionLimit(action: QueryMethodAction, rest: string): ActionMatch {
  const topOrFirst = /^(Top|First)(\d*)/.exec(rest);

  if (!topOrFirst) {
    return { action, rest };
  }

  const limit = topOrFirst[2] === "" ? 1 : Number(topOrFirst[2]);
  return {
    action,
    rest: rest.slice(topOrFirst[0].length),
    limit,
  };
}

function parseSubject(
  subject: string,
  actionLimit: number | undefined,
): SubjectMatch {
  let rest = subject;
  let distinct = false;
  let limit = actionLimit;
  let changed = true;

  while (changed) {
    changed = false;

    if (rest.startsWith("Distinct")) {
      distinct = true;
      rest = rest.slice("Distinct".length);
      changed = true;
      continue;
    }

    if (rest.endsWith("Distinct")) {
      distinct = true;
      rest = rest.slice(0, -"Distinct".length);
      changed = true;
      continue;
    }

    const topOrFirst = /^(Top|First)(\d*)/.exec(rest);

    if (topOrFirst) {
      limit = topOrFirst[2] === "" ? 1 : Number(topOrFirst[2]);
      rest = rest.slice(topOrFirst[0].length);
      changed = true;
    }
  }

  return { distinct, limit };
}

function splitOrderBy(source: string): {
  predicateSource: string;
  orderBySource: string;
} {
  const orderByIndex = source.indexOf("OrderBy");

  if (orderByIndex < 0) {
    return { predicateSource: source, orderBySource: "" };
  }

  return {
    predicateSource: source.slice(0, orderByIndex),
    orderBySource: source.slice(orderByIndex + "OrderBy".length),
  };
}

function parsePredicate(source: string): QueryPredicatePart[] {
  if (source.length === 0) {
    throw new Error("Query method predicate must not be empty.");
  }

  const tokens = splitPredicateTokens(source);
  let parameterIndex = 0;

  return tokens.map(({ connector, token }) => {
    const condition = parseCondition(token, parameterIndex);
    parameterIndex += getParameterCount(condition.operator);

    return connector ? { connector, condition } : { condition };
  });
}

function stripAllIgnoreCase(source: string): {
  source: string;
  allIgnoreCase: boolean;
} {
  if (!source.endsWith("AllIgnoreCase")) {
    return { source, allIgnoreCase: false };
  }

  return {
    source: source.slice(0, -"AllIgnoreCase".length),
    allIgnoreCase: true,
  };
}

function splitPredicateTokens(
  source: string,
): Array<{ connector?: QueryLogicalOperator; token: string }> {
  const result: Array<{ connector?: QueryLogicalOperator; token: string }> = [];
  let connector: QueryLogicalOperator | undefined;
  let start = 0;

  for (let index = 0; index < source.length; index += 1) {
    const matched = matchConnector(source, index);

    if (!matched) {
      continue;
    }

    result.push({ connector, token: source.slice(start, index) });
    connector = matched.connector;
    index += matched.text.length - 1;
    start = index + 1;
  }

  result.push({ connector, token: source.slice(start) });

  for (const part of result) {
    if (part.token.length === 0) {
      throw new Error(`Invalid empty predicate in "${source}".`);
    }
  }

  return result;
}

function matchConnector(
  source: string,
  index: number,
): { connector: QueryLogicalOperator; text: string } | undefined {
  if (source.startsWith("And", index) && isBoundary(source, index + 3)) {
    return { connector: "and", text: "And" };
  }

  if (source.startsWith("Or", index) && isBoundary(source, index + 2)) {
    return { connector: "or", text: "Or" };
  }

  return undefined;
}

function isBoundary(source: string, index: number): boolean {
  const next = source[index];
  return next === undefined || next === next.toUpperCase();
}

function parseCondition(token: string, parameterIndex: number): QueryCondition {
  const ignoreCase = token.endsWith("IgnoreCase");
  const source = ignoreCase ? token.slice(0, -"IgnoreCase".length) : token;

  for (const definition of OPERATORS) {
    if (!source.endsWith(definition.suffix)) {
      continue;
    }

    const property = source.slice(0, -definition.suffix.length);

    if (property.length === 0) {
      continue;
    }

    return {
      property: toPropertyName(property),
      operator: definition.operator,
      parameterIndex:
        definition.parameterCount === 0 ? undefined : parameterIndex,
      ...(ignoreCase ? { ignoreCase: true } : {}),
    };
  }

  return {
    property: toPropertyName(source),
    operator: "equals",
    parameterIndex,
    ...(ignoreCase ? { ignoreCase: true } : {}),
  };
}

function parseOrderBy(source: string): QueryOrder[] {
  if (source.length === 0) {
    return [];
  }

  const orders: QueryOrder[] = [];
  const pattern = /([A-Z][a-zA-Z0-9]*?)(Asc|Desc)(?=[A-Z]|$)/g;
  let matchedLength = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    orders.push({
      property: toPropertyName(match[1]),
      direction: match[2] === "Asc" ? "asc" : "desc",
    });
    matchedLength += match[0].length;
  }

  if (orders.length === 0 || matchedLength !== source.length) {
    throw new Error(
      `Invalid OrderBy clause "${source}". Use fields followed by Asc or Desc.`,
    );
  }

  return orders;
}

function getParameterCount(operator: QueryOperator): number {
  const definition = OPERATORS.find((item) => item.operator === operator);
  return definition?.parameterCount ?? 1;
}

function toPropertyName(source: string): string {
  return source.charAt(0).toLowerCase() + source.slice(1);
}
