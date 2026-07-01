import type { QueryMethodAction, QueryOperator } from "@honeybeaers/npa/query-method";
import {
  findEntitySchema,
  getDirectQueryProperties,
  getRelationProperties,
  toMethodSegment,
} from "./entity-schema";
import {
  NPAQueryMethodCompletionKind,
  type GetNPAQueryMethodCompletionsOptions,
  type NPALanguageEntitySchema,
  type NPAQueryMethodCompletion,
  type NPAQueryMethodCompletionParameter,
} from "./types";

interface QueryableCompletionProperty {
  methodSegment: string;
  label: string;
  type?: string;
  relation: boolean;
}

interface CompletionOperator {
  suffix: string;
  operator: QueryOperator;
  parameterCount: number;
  rank: number;
}

interface CompletionActionSubject {
  action: QueryMethodAction;
  subject: string;
  rank: number;
}

const DEFAULT_ACTIONS: QueryMethodAction[] = [
  "find",
  "findOne",
  "exists",
  "count",
  "delete",
];

const COMMON_OPERATORS: CompletionOperator[] = [
  { suffix: "", operator: "equals", parameterCount: 1, rank: 0 },
  { suffix: "Not", operator: "not", parameterCount: 1, rank: 10 },
  { suffix: "In", operator: "in", parameterCount: 1, rank: 20 },
  { suffix: "NotIn", operator: "notIn", parameterCount: 1, rank: 21 },
  { suffix: "IsNull", operator: "isNull", parameterCount: 0, rank: 30 },
  { suffix: "IsNotNull", operator: "isNotNull", parameterCount: 0, rank: 31 },
];

const STRING_OPERATORS: CompletionOperator[] = [
  { suffix: "Containing", operator: "containing", parameterCount: 1, rank: 5 },
  { suffix: "StartingWith", operator: "startingWith", parameterCount: 1, rank: 6 },
  { suffix: "EndingWith", operator: "endingWith", parameterCount: 1, rank: 7 },
  { suffix: "Like", operator: "like", parameterCount: 1, rank: 8 },
];

const RANGE_OPERATORS: CompletionOperator[] = [
  { suffix: "GreaterThan", operator: "greaterThan", parameterCount: 1, rank: 5 },
  { suffix: "GreaterThanEqual", operator: "greaterThanEqual", parameterCount: 1, rank: 6 },
  { suffix: "LessThan", operator: "lessThan", parameterCount: 1, rank: 7 },
  { suffix: "LessThanEqual", operator: "lessThanEqual", parameterCount: 1, rank: 8 },
  { suffix: "Between", operator: "between", parameterCount: 2, rank: 9 },
];

const BOOLEAN_OPERATORS: CompletionOperator[] = [
  { suffix: "True", operator: "true", parameterCount: 0, rank: 5 },
  { suffix: "False", operator: "false", parameterCount: 0, rank: 6 },
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
            const name = `${actionSubject.subject}By${property.methodSegment}${operator.suffix}${predicateSuffix.suffix}`;
            completions.push(toCompletion({
              action: actionSubject.action,
              actionRank: actionSubject.rank,
              entity: options.entity,
              name,
              operator,
              predicateSuffixRank: predicateSuffix.rank,
              property,
            }));

            if (options.includeOrderBy && canOrder(actionSubject.action)) {
              completions.push(
                ...getOrderByCompletions({
                  action: actionSubject.action,
                  actionRank: actionSubject.rank,
                  entity: options.entity,
                  name,
                  operator,
                  orderProperties,
                  predicateSuffixRank: predicateSuffix.rank,
                  property,
                }),
              );
            }
          }
        }
      }
    }
  }

  return uniqueCompletions(completions)
    .filter((completion) => completion.name.startsWith(options.prefix))
    .sort((left, right) => (left.sortText ?? left.name).localeCompare(right.sortText ?? right.name))
    .slice(0, options.limit ?? 100);
}

function getActionSubjects(action: QueryMethodAction): CompletionActionSubject[] {
  const baseRank = getActionRank(action);
  const subjects: CompletionActionSubject[] = [{ action, subject: action, rank: baseRank }];

  if (action === "find") {
    subjects.push(
      { action, subject: "findFirst", rank: baseRank + 1 },
      { action, subject: "findTop", rank: baseRank + 2 },
      { action, subject: "findTop10", rank: baseRank + 3 },
      { action, subject: "findDistinct", rank: baseRank + 4 },
      { action, subject: "findDistinctFirst", rank: baseRank + 5 },
      { action, subject: "findDistinctTop", rank: baseRank + 6 },
      { action, subject: "findDistinctTop10", rank: baseRank + 7 },
    );
  }

  if (action === "findOne") {
    subjects.push({ action, subject: "findOneDistinct", rank: baseRank + 1 });
  }

  if (action === "count") {
    subjects.push({ action, subject: "countDistinct", rank: baseRank + 1 });
  }

  return subjects;
}

function getActionRank(action: QueryMethodAction): number {
  return DEFAULT_ACTIONS.indexOf(action) * 20;
}

function getPredicateSuffixes(
  property: QueryableCompletionProperty,
  operator: CompletionOperator,
): Array<{ suffix: string; rank: number }> {
  const suffixes = [{ suffix: "", rank: 0 }];

  if (operator.parameterCount > 0 && normalizeType(property.type) === "string") {
    suffixes.push(
      { suffix: "IgnoreCase", rank: 1 },
      { suffix: "AllIgnoreCase", rank: 2 },
    );
  }

  return suffixes;
}

function getOrderByCompletions(options: {
  action: QueryMethodAction;
  actionRank: number;
  entity: NPALanguageEntitySchema;
  name: string;
  operator: CompletionOperator;
  orderProperties: ReturnType<typeof getDirectQueryProperties>;
  predicateSuffixRank: number;
  property: QueryableCompletionProperty;
}): NPAQueryMethodCompletion[] {
  const completions: NPAQueryMethodCompletion[] = [];

  for (const orderProperty of options.orderProperties) {
    completions.push(
      toCompletion({
        ...options,
        name: `${options.name}OrderBy${toMethodSegment(orderProperty.name)}Asc`,
        orderRank: 40,
      }),
      toCompletion({
        ...options,
        name: `${options.name}OrderBy${toMethodSegment(orderProperty.name)}Desc`,
        orderRank: 41,
      }),
    );
  }

  for (const left of options.orderProperties) {
    for (const right of options.orderProperties) {
      if (left.name === right.name) {
        continue;
      }

      completions.push(
        toCompletion({
          ...options,
          name: `${options.name}OrderBy${toMethodSegment(left.name)}Asc${toMethodSegment(right.name)}Desc`,
          orderRank: 50,
        }),
        toCompletion({
          ...options,
          name: `${options.name}OrderBy${toMethodSegment(left.name)}Desc${toMethodSegment(right.name)}Asc`,
          orderRank: 51,
        }),
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
    relation: false,
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
      relation: true,
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

function toCompletion(options: {
  action: QueryMethodAction;
  actionRank: number;
  entity: NPALanguageEntitySchema;
  name: string;
  operator: CompletionOperator;
  orderRank?: number;
  predicateSuffixRank: number;
  property: QueryableCompletionProperty;
}): NPAQueryMethodCompletion {
  const parameters = getParameters(options.property, options.operator);
  const returnType = getReturnType(options.action, options.entity.className);
  const parameterText = parameters.map((parameter) => `${parameter.name}: ${parameter.type}`).join(", ");
  const snippetParameterText = parameters
    .map((parameter, index) => `\${${index + 1}:${parameter.name}}: ${parameter.type}`)
    .join(", ");
  const signature = `${options.name}(${parameterText}): ${returnType};`;
  const detail = `${returnType} - ${options.property.label} ${options.operator.operator}`;
  const sortText = [
    options.actionRank,
    options.property.relation ? 1 : 0,
    options.operator.rank,
    options.predicateSuffixRank,
    options.orderRank ?? 0,
    options.name,
  ].map((part) => typeof part === "number" ? String(part).padStart(3, "0") : part).join(":");

  return {
    kind: NPAQueryMethodCompletionKind.METHOD,
    name: options.name,
    insertText: `${options.name}(${snippetParameterText}): ${returnType};`,
    detail,
    sortText,
    filterText: options.name,
    documentation: `Runs a ${options.action} query on ${options.property.label} using ${options.operator.operator}.`,
    signature,
    returnType,
    parameters,
  };
}

function getParameters(
  property: QueryableCompletionProperty,
  operator: CompletionOperator,
): NPAQueryMethodCompletionParameter[] {
  if (operator.parameterCount === 0) {
    return [];
  }

  const type = getParameterType(property.type, operator.operator);
  const baseName = toParameterName(property.label);

  if (operator.operator === "between") {
    return [
      { name: `min${toMethodSegment(baseName)}`, type },
      { name: `max${toMethodSegment(baseName)}`, type },
    ];
  }

  if (operator.operator === "in" || operator.operator === "notIn") {
    return [{ name: `${baseName}Values`, type: `ReadonlyArray<${getParameterType(property.type)}>` }];
  }

  return [{ name: baseName, type }];
}

function getParameterType(type: string | undefined, operator?: QueryOperator): string {
  const normalized = normalizeType(type);

  if (normalized === "date") {
    return "Date";
  }

  if (["string", "number", "boolean"].includes(normalized)) {
    return normalized;
  }

  if (operator === "in" || operator === "notIn") {
    return "unknown";
  }

  return "unknown";
}

function getReturnType(action: QueryMethodAction, entityName: string): string {
  if (action === "findOne") {
    return `Promise<${entityName} | null>`;
  }

  if (action === "exists") {
    return "Promise<boolean>";
  }

  if (action === "count") {
    return "Promise<number>";
  }

  if (action === "delete") {
    return "Promise<number>";
  }

  return `Promise<${entityName}[]>`;
}

function canOrder(action: QueryMethodAction): boolean {
  return action === "find" || action === "findOne";
}

function toParameterName(label: string): string {
  return label
    .split(".")
    .map((part, index) => index === 0 ? part : toMethodSegment(part))
    .join("");
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
