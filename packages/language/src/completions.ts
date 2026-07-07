import {
  findDuplicateQueryPredicates,
  type QueryMethodAction,
  type QueryOperator,
} from "@node-persistence-api/core/query-method";
import {
  findEntitySchema,
  getDirectQueryProperties,
  getRelationProperties,
  isManyToOneRelationProperty,
  resolveQueryProperty,
  toMethodSegment,
} from "./entity-schema";
import { parseNPAQueryMethodName } from "./method-name";
import { normalizeType } from "./type-utils";
import {
  NPAQueryMethodCompletionKind,
  type GetNPAQueryMethodCompletionsOptions,
  type NPALanguageEntitySchema,
  type NPAQueryMethodCompletion,
  type NPAQueryMethodCompletionParameter,
  type NPALanguageWorkspaceSchema,
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
              workspace: options.workspace,
              includePageable: options.includePageable,
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
                  workspace: options.workspace,
                  includePageable: options.includePageable,
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

  const compoundContext = getPredicateCompletionContext(options.prefix);
  const compoundAction = compoundContext ? getActionFromPrefix(compoundContext.head) : undefined;

  if (compoundContext && compoundAction && actions.includes(compoundAction)) {
    for (const property of properties) {
      for (const operator of getOperatorsForType(property.type)) {
        for (const predicateSuffix of getPredicateSuffixes(property, operator)) {
          const name = `${compoundContext.head}${property.methodSegment}${operator.suffix}${predicateSuffix.suffix}`;
          completions.push(toCompletion({
            action: compoundAction,
            actionRank: getActionRank(compoundAction),
            entity: options.entity,
            name,
            operator,
            includePageable: options.includePageable,
            predicateSuffixRank: predicateSuffix.rank,
            property,
            workspace: options.workspace,
          }));

          if (options.includeOrderBy && canOrder(compoundAction)) {
            completions.push(
              ...getOrderByCompletions({
                action: compoundAction,
                actionRank: getActionRank(compoundAction),
                entity: options.entity,
                name,
                operator,
                includePageable: options.includePageable,
                orderProperties,
                predicateSuffixRank: predicateSuffix.rank,
                property,
                workspace: options.workspace,
              }),
            );
          }
        }
      }
    }
  }

  return uniqueCompletions(completions)
    .filter((completion) => completion.name.startsWith(options.prefix))
    .filter((completion) => !hasDuplicatePredicates(completion.name))
    .sort((left, right) => (left.sortText ?? left.name).localeCompare(right.sortText ?? right.name))
    .slice(0, options.limit ?? 100);
}

function hasDuplicatePredicates(methodName: string): boolean {
  try {
    return findDuplicateQueryPredicates(parseNPAQueryMethodName(methodName)).length > 0;
  } catch {
    return false;
  }
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

function getActionFromPrefix(prefix: string): QueryMethodAction | undefined {
  if (prefix.startsWith("findOne")) {
    return "findOne";
  }

  if (prefix.startsWith("find")) {
    return "find";
  }

  if (prefix.startsWith("exists")) {
    return "exists";
  }

  if (prefix.startsWith("count")) {
    return "count";
  }

  if (prefix.startsWith("delete")) {
    return "delete";
  }

  return undefined;
}

function getPredicateCompletionContext(prefix: string): {
  head: string;
  currentSegment: string;
} | undefined {
  const byIndex = prefix.indexOf("By");

  if (byIndex < 0) {
    return undefined;
  }

  const predicateStart = byIndex + "By".length;
  const predicateSource = prefix.slice(predicateStart);

  if (predicateSource.includes("OrderBy")) {
    return undefined;
  }

  let lastConnector: { index: number; text: "And" | "Or" } | undefined;

  for (let index = predicateStart; index < prefix.length; index += 1) {
    const connector = matchPredicateConnector(prefix, index);

    if (connector) {
      lastConnector = { index, text: connector };
      index += connector.length - 1;
    }
  }

  if (!lastConnector || lastConnector.index === predicateStart) {
    return undefined;
  }

  const headEnd = lastConnector.index + lastConnector.text.length;
  return {
    head: prefix.slice(0, headEnd),
    currentSegment: prefix.slice(headEnd),
  };
}

function matchPredicateConnector(
  source: string,
  index: number,
): "And" | "Or" | undefined {
  if (source.startsWith("And", index) && isConnectorBoundary(source, index + 3)) {
    return "And";
  }

  if (source.startsWith("Or", index) && isConnectorBoundary(source, index + 2)) {
    return "Or";
  }

  return undefined;
}

function isConnectorBoundary(source: string, index: number): boolean {
  const next = source[index];
  return next === undefined || next === next.toUpperCase();
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
  includePageable?: boolean;
  name: string;
  operator: CompletionOperator;
  workspace?: GetNPAQueryMethodCompletionsOptions["workspace"];
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

  const relationObjects = getRelationProperties(entity)
    .filter(isManyToOneRelationProperty)
    .map((relation) => ({
      methodSegment: toMethodSegment(relation.name),
      label: relation.name,
      type: relation.target,
      relation: true,
    }));

  const relationFields = getNestedRelationCompletionProperties(
    entity,
    workspace,
  );

  return [...direct, ...relationObjects, ...relationFields];
}

function getNestedRelationCompletionProperties(
  entity: NPALanguageEntitySchema,
  workspace: NPALanguageWorkspaceSchema | undefined,
): QueryableCompletionProperty[] {
  return getRelationProperties(entity).flatMap((relation) =>
    getRelationCompletionProperties(
      relation.name,
      relation.name,
      relation.target,
      workspace,
      new Set([entity.className]),
    ),
  );
}

function getRelationCompletionProperties(
  methodPrefix: string,
  labelPrefix: string,
  targetName: string | undefined,
  workspace: NPALanguageWorkspaceSchema | undefined,
  visited: Set<string>,
): QueryableCompletionProperty[] {
  const target = findEntitySchema(workspace, targetName);

  if (!target || visited.has(target.className)) {
    return [];
  }

  const nextVisited = new Set(visited);
  nextVisited.add(target.className);

  const direct = getDirectQueryProperties(target).map((property) => ({
    methodSegment: `${toMethodSegment(methodPrefix)}${toMethodSegment(property.name)}`,
    label: `${labelPrefix}.${property.name}`,
    type: property.type,
    relation: true,
  }));

  const nested = getRelationProperties(target).flatMap((relation) =>
    getRelationCompletionProperties(
      `${methodPrefix}${toMethodSegment(relation.name)}`,
      `${labelPrefix}.${relation.name}`,
      relation.target,
      workspace,
      nextVisited,
    ),
  );

  return [...direct, ...nested];
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
  includePageable?: boolean;
  name: string;
  operator: CompletionOperator;
  orderRank?: number;
  predicateSuffixRank: number;
  property: QueryableCompletionProperty;
  workspace?: GetNPAQueryMethodCompletionsOptions["workspace"];
}): NPAQueryMethodCompletion {
  const queryParameters = getMethodParameters(options.name, options.entity, options.workspace) ??
    getParameters(options.property, options.operator);
  const hasPageable = options.includePageable && canUsePageable(options.action, options.name);
  const parameters = hasPageable
    ? [...queryParameters, { name: "pageable", type: "PageRequest", optional: true }]
    : queryParameters;
  const returnType = hasPageable
    ? getPageableReturnType(options.entity.className)
    : getReturnType(options.action, options.entity.className);
  const parameterText = parameters.map(formatParameter).join(", ");
  const snippetParameterText = parameters
    .map((parameter, index) => `\${${index + 1}:${parameter.name}}${parameter.optional ? "?" : ""}: ${parameter.type}`)
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

function getMethodParameters(
  methodName: string,
  entity: NPALanguageEntitySchema,
  workspace: GetNPAQueryMethodCompletionsOptions["workspace"],
): NPAQueryMethodCompletionParameter[] | undefined {
  try {
    return parseNPAQueryMethodName(methodName).predicate.flatMap((part) => {
      const resolved = resolveQueryProperty(entity, part.condition.property, workspace);
      const type = resolved?.property.type;
      const baseName = toParameterName(resolved?.path.join(".") ?? part.condition.property);
      return getParametersForOperator(baseName, type, part.condition.operator);
    });
  } catch {
    return undefined;
  }
}

function getParameters(
  property: QueryableCompletionProperty,
  operator: CompletionOperator,
): NPAQueryMethodCompletionParameter[] {
  return getParametersForOperator(
    toParameterName(property.label),
    property.type,
    operator.operator,
  );
}

function getParametersForOperator(
  baseName: string,
  typeSource: string | undefined,
  operator: QueryOperator,
): NPAQueryMethodCompletionParameter[] {
  if (isParameterlessOperator(operator)) {
    return [];
  }

  const type = getParameterType(typeSource);

  if (operator === "between") {
    return [
      { name: `min${toMethodSegment(baseName)}`, type },
      { name: `max${toMethodSegment(baseName)}`, type },
    ];
  }

  if (operator === "in" || operator === "notIn") {
    return [{ name: `${baseName}Values`, type: `ReadonlyArray<${getParameterType(typeSource)}>` }];
  }

  return [{ name: baseName, type }];
}

function isParameterlessOperator(operator: QueryOperator): boolean {
  return operator === "isNull" ||
    operator === "isNotNull" ||
    operator === "true" ||
    operator === "false";
}

function getParameterType(type: string | undefined): string {
  const normalized = normalizeType(type);

  if (normalized === "date") {
    return "Date";
  }

  if (["string", "number", "boolean"].includes(normalized)) {
    return normalized;
  }

  const explicitType = normalizeExplicitType(type);

  if (explicitType) {
    return explicitType;
  }

  return "unknown";
}

function normalizeExplicitType(type: string | undefined): string | undefined {
  const explicitType = type
    ?.replace(/\s*\|\s*undefined/g, "")
    .replace(/\s*\|\s*null/g, "")
    .replace(/\[\]/g, "")
    .replace(/\?/g, "")
    .trim();

  return explicitType && /^[A-Za-z_$][\w$]*(?:<.*>)?$/.test(explicitType)
    ? explicitType
    : undefined;
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

function getPageableReturnType(entityName: string): string {
  return `Promise<${entityName}[] | Page<${entityName}> | CursorPage<${entityName}>>`;
}

function formatParameter(parameter: NPAQueryMethodCompletionParameter): string {
  return `${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type}`;
}

function canUsePageable(action: QueryMethodAction, methodName: string): boolean {
  return action === "find" && !/^find(?:Distinct)?(?:First|Top)/.test(methodName);
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
