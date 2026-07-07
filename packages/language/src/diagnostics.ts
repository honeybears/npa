import {
  findDuplicateQueryPredicates,
  type QueryOperator,
  type QueryPredicatePart,
} from "@node-persistence-api/core/query-method";
import {
  getDirectQueryProperties,
  getRelationProperties,
  findEntitySchema,
  isManyToOneRelationProperty,
  resolveQueryProperty,
  toMethodSegment,
} from "./entity-schema";
import { parseNPAQueryMethodName } from "./method-name";
import { normalizeType } from "./type-utils";
import {
  NPAQueryMethodDiagnosticCode,
  NPAQueryMethodDiagnosticSeverity,
  type NPALanguageEntitySchema,
  type NPALanguageEntityProperty,
  type NPALanguageWorkspaceSchema,
  type NPAQueryMethodDiagnostic,
  type NPAQueryMethodDiagnosticSuggestion,
  type ValidateNPAQueryMethodOptions,
  type NPAQueryMethodValidationResult,
} from "./types";

const OPERATOR_SUFFIXES: Record<QueryOperator, string> = {
  equals: "",
  not: "Not",
  lessThan: "LessThan",
  lessThanEqual: "LessThanEqual",
  greaterThan: "GreaterThan",
  greaterThanEqual: "GreaterThanEqual",
  between: "Between",
  like: "Like",
  startingWith: "StartingWith",
  endingWith: "EndingWith",
  containing: "Containing",
  in: "In",
  notIn: "NotIn",
  isNull: "IsNull",
  isNotNull: "IsNotNull",
  true: "True",
  false: "False",
};

function getPredicateRangeText(part: QueryPredicatePart): string {
  const connector = part.connector === "and"
    ? "And"
    : part.connector === "or"
      ? "Or"
      : "";

  return `${connector}${toMethodSegment(part.condition.property)}${OPERATOR_SUFFIXES[part.condition.operator]}${part.condition.ignoreCase ? "IgnoreCase" : ""}`;
}

export function validateNPAQueryMethod(
  options: ValidateNPAQueryMethodOptions,
): NPAQueryMethodValidationResult {
  const diagnostics: NPAQueryMethodDiagnostic[] = [];

  try {
    const parsed = parseNPAQueryMethodName(options.methodName);

    for (const duplicate of findDuplicateQueryPredicates(parsed)) {
      diagnostics.push(error(
        NPAQueryMethodDiagnosticCode.DUPLICATE_PREDICATE,
        `Duplicate query predicate "${duplicate.property}" with operator "${duplicate.operator}" in ${options.methodName}. Use a different operator or In/NotIn instead.`,
        duplicate.property,
        getPredicateRangeText(duplicate.duplicate),
      ));
    }

    for (const part of parsed.predicate) {
      const methodProperty = part.condition.property;
      const methodPropertySegment = toMethodSegment(methodProperty);
      const resolved = resolveQueryProperty(
        options.entity,
        methodProperty,
        options.workspace,
      );

      if (!resolved) {
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNKNOWN_PROPERTY,
          `Unknown query property "${methodProperty}" on ${options.entity.className}.`,
          methodProperty,
          methodPropertySegment,
          getUnknownPropertySuggestions(options.methodName, methodProperty, options.entity, options.workspace),
        ));
        continue;
      }

      if (resolved.missingRelationTarget) {
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNKNOWN_RELATION_TARGET,
          `Relation target "${resolved.missingRelationTarget}" is not available for "${methodProperty}" completion or validation.`,
          methodProperty,
          methodPropertySegment,
        ));
        continue;
      }

      if (!isOperatorCompatible(
        part.condition.operator,
        resolved.property.type,
        resolved.property.kind === "RELATION",
      )) {
        const operatorSuffix = OPERATOR_SUFFIXES[part.condition.operator];
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR,
          `Operator "${part.condition.operator}" is not supported for property "${resolved.path.join(".")}".`,
          methodProperty,
          operatorSuffix || methodPropertySegment,
          getUnsupportedOperatorSuggestions(options.methodName, methodProperty, part.condition.operator),
        ));
      }

      if (
        (part.condition.ignoreCase || parsed.allIgnoreCase) &&
        !isIgnoreCaseCompatible(part.condition.operator, resolved.property.type)
      ) {
        const rangeText = parsed.allIgnoreCase ? "AllIgnoreCase" : "IgnoreCase";
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR,
          `IgnoreCase is only supported for string comparisons on property "${resolved.path.join(".")}".`,
          methodProperty,
          rangeText,
          getRemoveSuffixSuggestion(options.methodName, rangeText),
        ));
      }
    }

    for (const order of parsed.orderBy) {
      const orderProperty = resolveQueryProperty(
        options.entity,
        order.property,
        options.workspace,
      );

      if (!orderProperty) {
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNSUPPORTED_ORDER_PROPERTY,
          `OrderBy property "${order.property}" must resolve to a scalar property on ${options.entity.className}.`,
          order.property,
          toMethodSegment(order.property),
          getOrderByPropertySuggestions(options.methodName, order.property, options.entity, options.workspace),
        ));
        continue;
      }

      if (
        orderProperty.missingRelationTarget ||
        orderProperty.property.kind === "RELATION"
      ) {
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNSUPPORTED_ORDER_PROPERTY,
          `OrderBy property "${order.property}" must resolve to a scalar property on ${options.entity.className}.`,
          order.property,
          toMethodSegment(order.property),
          getOrderByPropertySuggestions(options.methodName, order.property, options.entity, options.workspace),
        ));
      }
    }

    return { parsed, diagnostics };
  } catch (caught) {
    diagnostics.push(error(
      NPAQueryMethodDiagnosticCode.INVALID_METHOD_NAME,
      caught instanceof Error ? caught.message : String(caught),
    ));

    return { diagnostics };
  }
}

function getUnknownPropertySuggestions(
  methodName: string,
  methodProperty: string,
  entity: NPALanguageEntitySchema,
  workspace: NPALanguageWorkspaceSchema | undefined,
): NPAQueryMethodDiagnosticSuggestion[] {
  const sourceSegment = toMethodSegment(methodProperty);

  return getQueryableProperties(entity, workspace)
    .map((candidate) => ({
      candidate,
      distance: levenshtein(methodProperty.toLowerCase(), candidate.methodProperty.toLowerCase()),
    }))
    .filter((item) => item.distance <= Math.max(2, Math.floor(methodProperty.length / 2)))
    .sort((left, right) => left.distance - right.distance || left.candidate.methodProperty.localeCompare(right.candidate.methodProperty))
    .slice(0, 3)
    .map((item) => {
      const replacementMethodName = replaceFirst(methodName, sourceSegment, item.candidate.methodSegment);
      return {
        title: `Change to ${replacementMethodName}`,
        replacementMethodName,
      };
    });
}

function getUnsupportedOperatorSuggestions(
  methodName: string,
  methodProperty: string,
  operator: QueryOperator,
): NPAQueryMethodDiagnosticSuggestion[] {
  const suffix = OPERATOR_SUFFIXES[operator];

  if (!suffix) {
    return [];
  }

  const propertySegment = toMethodSegment(methodProperty);
  const source = `${propertySegment}${suffix}`;
  const replacementMethodName = replaceFirst(methodName, source, propertySegment);

  if (replacementMethodName === methodName) {
    return [];
  }

  return [{ title: `Use equality query ${replacementMethodName}`, replacementMethodName }];
}

function getRemoveSuffixSuggestion(
  methodName: string,
  suffix: string,
): NPAQueryMethodDiagnosticSuggestion[] {
  const replacementMethodName = replaceFirst(methodName, suffix, "");

  if (replacementMethodName === methodName) {
    return [];
  }

  return [{ title: `Remove ${suffix}`, replacementMethodName }];
}

function getOrderByPropertySuggestions(
  methodName: string,
  orderProperty: string,
  entity: NPALanguageEntitySchema,
  workspace: NPALanguageWorkspaceSchema | undefined,
): NPAQueryMethodDiagnosticSuggestion[] {
  const sourceSegment = toMethodSegment(orderProperty);

  return getQueryableProperties(entity, workspace)
    .map((candidate) => ({
      candidate,
      distance: levenshtein(orderProperty.toLowerCase(), candidate.methodProperty.toLowerCase()),
    }))
    .filter((item) => item.distance <= Math.max(2, Math.floor(orderProperty.length / 2)))
    .sort((left, right) => left.distance - right.distance || left.candidate.methodProperty.localeCompare(right.candidate.methodProperty))
    .slice(0, 3)
    .map((item) => {
      const replacementMethodName = replaceFirst(methodName, sourceSegment, item.candidate.methodSegment);
      return {
        title: `Order by ${item.candidate.methodProperty}`,
        replacementMethodName,
      };
    });
}

function getQueryableProperties(
  entity: NPALanguageEntitySchema,
  workspace: NPALanguageWorkspaceSchema | undefined,
): Array<{ methodProperty: string; methodSegment: string }> {
  const direct = getDirectQueryProperties(entity).map((property) => ({
    methodProperty: property.name,
    methodSegment: toMethodSegment(property.name),
  }));

  const relationObjects = getRelationProperties(entity)
    .filter(isManyToOneRelationProperty)
    .map((property) => ({
      methodProperty: property.name,
      methodSegment: toMethodSegment(property.name),
    }));

  const relationFields = getNestedRelationQueryProperties(
    entity,
    workspace,
  );

  return [...direct, ...relationObjects, ...relationFields];
}

function getNestedRelationQueryProperties(
  entity: NPALanguageEntitySchema,
  workspace: NPALanguageWorkspaceSchema | undefined,
): Array<{ methodProperty: string; methodSegment: string }> {
  return getRelationProperties(entity).flatMap((relation) =>
    getRelationQueryProperties(
      relation,
      relation.name,
      toMethodSegment(relation.name),
      workspace,
      new Set([entity.className]),
    ),
  );
}

function getRelationQueryProperties(
  relation: NPALanguageEntityProperty,
  methodPrefix: string,
  methodSegmentPrefix: string,
  workspace: NPALanguageWorkspaceSchema | undefined,
  visited: Set<string>,
): Array<{ methodProperty: string; methodSegment: string }> {
  const target = findEntitySchema(workspace, relation.target);

  if (!target || visited.has(target.className)) {
    return [];
  }

  const nextVisited = new Set(visited);
  nextVisited.add(target.className);

  const direct = getDirectQueryProperties(target).map((property) => ({
    methodProperty: `${methodPrefix}${toMethodSegment(property.name)}`,
    methodSegment: `${methodSegmentPrefix}${toMethodSegment(property.name)}`,
  }));

  const nested = getRelationProperties(target).flatMap((nextRelation) =>
    getRelationQueryProperties(
      nextRelation,
      `${methodPrefix}${toMethodSegment(nextRelation.name)}`,
      `${methodSegmentPrefix}${toMethodSegment(nextRelation.name)}`,
      workspace,
      nextVisited,
    ),
  );

  return [...direct, ...nested];
}

function isOperatorCompatible(
  operator: QueryOperator,
  type: string | undefined,
  relation: boolean,
): boolean {
  const normalized = normalizeType(type);

  if (relation) {
    return isCommonOperator(operator);
  }

  if (isCommonOperator(operator)) {
    return true;
  }

  if (normalized === "unknown") {
    return true;
  }

  if (operator === "true" || operator === "false") {
    return normalized === "boolean";
  }

  if (isStringOperator(operator)) {
    return normalized === "string";
  }

  if (isRangeOperator(operator)) {
    return normalized === "number" || normalized === "date";
  }

  return true;
}

function isCommonOperator(operator: QueryOperator): boolean {
  return [
    "equals",
    "not",
    "in",
    "notIn",
    "isNull",
    "isNotNull",
  ].includes(operator);
}

function isStringOperator(operator: QueryOperator): boolean {
  return [
    "containing",
    "startingWith",
    "endingWith",
    "like",
  ].includes(operator);
}

function isRangeOperator(operator: QueryOperator): boolean {
  return [
    "lessThan",
    "lessThanEqual",
    "greaterThan",
    "greaterThanEqual",
    "between",
  ].includes(operator);
}

function isIgnoreCaseCompatible(
  operator: QueryOperator,
  type: string | undefined,
): boolean {
  const normalized = normalizeType(type);

  if (normalized === "unknown") {
    return true;
  }

  return normalized === "string" && isIgnoreCaseOperator(operator);
}

function isIgnoreCaseOperator(operator: QueryOperator): boolean {
  return [
    "equals",
    "not",
    "in",
    "notIn",
    "containing",
    "startingWith",
    "endingWith",
    "like",
  ].includes(operator);
}

function error(
  code: NPAQueryMethodDiagnosticCode,
  message: string,
  property?: string,
  rangeText?: string,
  suggestions: NPAQueryMethodDiagnosticSuggestion[] = [],
): NPAQueryMethodDiagnostic {
  return {
    code,
    severity: NPAQueryMethodDiagnosticSeverity.ERROR,
    message,
    property,
    rangeText,
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
}

function replaceFirst(source: string, search: string, replacement: string): string {
  const index = source.indexOf(search);

  if (index < 0) {
    return source;
  }

  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}
