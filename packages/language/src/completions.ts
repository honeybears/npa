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
}

const DEFAULT_ACTIONS: QueryMethodAction[] = [
  "find",
  "findOne",
  "exists",
  "count",
  "delete",
];

const COMMON_OPERATORS: CompletionOperator[] = [
  { suffix: "", operator: "equals" },
  { suffix: "Not", operator: "not" },
  { suffix: "In", operator: "in" },
  { suffix: "NotIn", operator: "notIn" },
  { suffix: "IsNull", operator: "isNull" },
  { suffix: "IsNotNull", operator: "isNotNull" },
];

const STRING_OPERATORS: CompletionOperator[] = [
  { suffix: "Containing", operator: "containing" },
  { suffix: "StartingWith", operator: "startingWith" },
  { suffix: "EndingWith", operator: "endingWith" },
  { suffix: "Like", operator: "like" },
];

const RANGE_OPERATORS: CompletionOperator[] = [
  { suffix: "LessThan", operator: "lessThan" },
  { suffix: "LessThanEqual", operator: "lessThanEqual" },
  { suffix: "GreaterThan", operator: "greaterThan" },
  { suffix: "GreaterThanEqual", operator: "greaterThanEqual" },
  { suffix: "Between", operator: "between" },
];

const BOOLEAN_OPERATORS: CompletionOperator[] = [
  { suffix: "True", operator: "true" },
  { suffix: "False", operator: "false" },
];

export function getNPAQueryMethodCompletions(
  options: GetNPAQueryMethodCompletionsOptions,
): NPAQueryMethodCompletion[] {
  const actions = options.actions ?? DEFAULT_ACTIONS;
  const properties = getCompletionProperties(options.entity, options.workspace);
  const orderProperties = getDirectQueryProperties(options.entity);
  const completions: NPAQueryMethodCompletion[] = [];

  for (const action of actions) {
    for (const property of properties) {
      for (const operator of getOperatorsForType(property.type)) {
        const name = `${action}By${property.methodSegment}${operator.suffix}`;
        completions.push(toCompletion(name, property, operator));

        if (options.includeOrderBy && canOrder(action)) {
          completions.push(
            ...orderProperties.flatMap((orderProperty) => [
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
            ]),
          );
        }
      }
    }
  }

  return completions
    .filter((completion) => completion.name.startsWith(options.prefix))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, options.limit ?? 100);
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
