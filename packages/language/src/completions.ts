import type { QueryMethodAction, QueryOperator } from "@honeybeaers/npa/query-method";
import {
  getDirectQueryProperties,
  getRelationProperties,
  findEntitySchema,
  toMethodSegment,
} from "./entity-schema";
import {
  NPAQueryMethodCompletionKind,
  type GetNPAQueryMethodCompletionsOptions,
  type NPALanguageEntitySchema,
  type NPAQueryMethodCompletion,
} from "./types";

interface QueryableCompletionProperty {
  methodSegment: string;
  label: string;
  type?: string;
}

interface CompletionOperator {
  suffix: string;
  operator: QueryOperator;
  parameterized: boolean;
}

interface CompletionActionSubject {
  action: QueryMethodAction;
  subject: string;
}

const DEFAULT_ACTIONS: QueryMethodAction[] = [
  "find",
  "findOne",
  "exists",
  "count",
  "delete",
];

const COMMON_OPERATORS: CompletionOperator[] = [
  { suffix: "", operator: "equals", parameterized: true },
  { suffix: "Not", operator: "not", parameterized: true },
  { suffix: "In", operator: "in", parameterized: true },
  { suffix: "NotIn", operator: "notIn", parameterized: true },
  { suffix: "IsNull", operator: "isNull", parameterized: false },
  { suffix: "IsNotNull", operator: "isNotNull", parameterized: false },
];

const STRING_OPERATORS: CompletionOperator[] = [
  { suffix: "Containing", operator: "containing", parameterized: true },
  { suffix: "StartingWith", operator: "startingWith", parameterized: true },
  { suffix: "EndingWith", operator: "endingWith", parameterized: true },
  { suffix: "Like", operator: "like", parameterized: true },
];

const RANGE_OPERATORS: CompletionOperator[] = [
  { suffix: "LessThan", operator: "lessThan", parameterized: true },
  { suffix: "LessThanEqual", operator: "lessThanEqual", parameterized: true },
  { suffix: "GreaterThan", operator: "greaterThan", parameterized: true },
  { suffix: "GreaterThanEqual", operator: "greaterThanEqual", parameterized: true },
  { suffix: "Between", operator: "between", parameterized: true },
];

const BOOLEAN_OPERATORS: CompletionOperator[] = [
  { suffix: "True", operator: "true", parameterized: false },
  { suffix: "False", operator: "false", parameterized: false },
];

export function getNPAQueryMethodCompletions(
  options: GetNPAQueryMethodCompletionsOptions,
): NPAQueryMethodCompletion[] {
  const actions = options.actions ?? DEFAULT_ACTIONS;
  const properties = getCompletionProperties(options.entity, options.workspace);
  const orderProperties = getDirectQueryProperties(options.entity);
  const completions: NPAQueryMethodCompletion[] = [];

  for (const action of actions) {
    const actionSubjects = getActionSubjects(action);

    for (const property of properties) {
      for (const operator of getOperatorsForType(property.type)) {
        for (const actionSubject of actionSubjects) {
          for (const predicateSuffix of getPredicateSuffixes(property, operator)) {
            const name = `${actionSubject.subject}By${property.methodSegment}${operator.suffix}${predicateSuffix}`;
            completions.push(toCompletion(name, property, operator));

            if (options.includeOrderBy && canOrder(actionSubject.action)) {
              completions.push(
                ...getOrderByCompletions(name, property, operator, orderProperties),
              );
            }
          }
        }
      }
    }
  }

  return uniqueCompletions(completions)
    .filter((completion) => completion.name.startsWith(options.prefix))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, options.limit ?? 100);
}

function getActionSubjects(action: QueryMethodAction): CompletionActionSubject[] {
  const subjects: CompletionActionSubject[] = [{ action, subject: action }];

  if (action === "find") {
    subjects.push(
      { action, subject: "findDistinct" },
      { action, subject: "findDistinctFirst" },
      { action, subject: "findDistinctTop" },
      { action, subject: "findDistinctTop10" },
      { action, subject: "findFirst" },
      { action, subject: "findTop" },
      { action, subject: "findTop10" },
    );
  }

  if (action === "findOne") {
    subjects.push({ action, subject: "findOneDistinct" });
  }

  if (action === "count") {
    subjects.push({ action, subject: "countDistinct" });
  }

  return subjects;
}

function getPredicateSuffixes(
  property: QueryableCompletionProperty,
  operator: CompletionOperator,
): string[] {
  const suffixes = [""];

  if (operator.parameterized && normalizeType(property.type) === "string") {
    suffixes.push("IgnoreCase", "AllIgnoreCase");
  }

  return suffixes;
}

function getOrderByCompletions(
  name: string,
  property: QueryableCompletionProperty,
  operator: CompletionOperator,
  orderProperties: ReturnType<typeof getDirectQueryProperties>,
): NPAQueryMethodCompletion[] {
  const completions: NPAQueryMethodCompletion[] = [];

  for (const orderProperty of orderProperties) {
    completions.push(
      toCompletion(
        `${name}OrderBy${toMethodSegment(orderProperty.name)}Asc`,
        property,
        operator,
      ),
      toCompletion(
        `${name}OrderBy${toMethodSegment(orderProperty.name)}Desc`,
        property,
        operator,
      ),
    );
  }

  for (const left of orderProperties) {
    for (const right of orderProperties) {
      if (left.name === right.name) {
        continue;
      }

      completions.push(
        toCompletion(
          `${name}OrderBy${toMethodSegment(left.name)}Asc${toMethodSegment(right.name)}Desc`,
          property,
          operator,
        ),
        toCompletion(
          `${name}OrderBy${toMethodSegment(left.name)}Desc${toMethodSegment(right.name)}Asc`,
          property,
          operator,
        ),
      );
    }
  }

  return completions;
}

function uniqueCompletions(
  completions: NPAQueryMethodCompletion[],
): NPAQueryMethodCompletion[] {
  return [...new Map(completions.map((completion) => [completion.name, completion])).values()];
}

function getCompletionProperties(
  entity: NPALanguageEntitySchema,
  workspace: GetNPAQueryMethodCompletionsOptions["workspace"],
): QueryableCompletionProperty[] {
  const direct = getDirectQueryProperties(entity).map((property) => ({
    methodSegment: toMethodSegment(property.name),
    label: property.name,
    type: property.type,
  }));

  const relationFields = getRelationProperties(entity).flatMap((relation) => {
    const target = findEntitySchema(workspace, relation.target);

    if (!target) {
      return [];
    }

    return getDirectQueryProperties(target).map((property) => ({
      methodSegment: `${toMethodSegment(relation.name)}${toMethodSegment(property.name)}`,
      label: `${relation.name}.${property.name}`,
      type: property.type,
    }));
  });

  return [...direct, ...relationFields];
}

function getOperatorsForType(type: string | undefined): CompletionOperator[] {
  const normalized = normalizeType(type);

  if (normalized === "string") {
    return [...COMMON_OPERATORS, ...STRING_OPERATORS];
  }

  if (normalized === "number" || normalized === "date") {
    return [...COMMON_OPERATORS, ...RANGE_OPERATORS];
  }

  if (normalized === "boolean") {
    return [...COMMON_OPERATORS, ...BOOLEAN_OPERATORS];
  }

  return COMMON_OPERATORS;
}

function toCompletion(
  name: string,
  property: QueryableCompletionProperty,
  operator: CompletionOperator,
): NPAQueryMethodCompletion {
  return {
    kind: NPAQueryMethodCompletionKind.METHOD,
    name,
    insertText: name,
    detail: `${property.label} ${operator.operator}`,
    sortText: name,
  };
}

function canOrder(action: QueryMethodAction): boolean {
  return action === "find" || action === "findOne";
}

function normalizeType(type: string | undefined): string {
  const normalized = (type ?? "")
    .replace(/\[\]/g, "")
    .replace(/\?/g, "")
    .toLowerCase();

  if (normalized.includes("string")) {
    return "string";
  }

  if (normalized.includes("number")) {
    return "number";
  }

  if (normalized.includes("boolean")) {
    return "boolean";
  }

  if (normalized.includes("date")) {
    return "date";
  }

  return "unknown";
}
