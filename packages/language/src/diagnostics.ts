import type { QueryOperator } from "@honeybeaers/npa/query-method";
import {
  getDirectQueryProperties,
  resolveQueryProperty,
} from "./entity-schema";
import { parseNPAQueryMethodName } from "./method-name";
import {
  NPAQueryMethodDiagnosticCode,
  NPAQueryMethodDiagnosticSeverity,
  type NPAQueryMethodDiagnostic,
  type NPAQueryMethodValidationResult,
  type ValidateNPAQueryMethodOptions,
} from "./types";

export function validateNPAQueryMethod(
  options: ValidateNPAQueryMethodOptions,
): NPAQueryMethodValidationResult {
  const diagnostics: NPAQueryMethodDiagnostic[] = [];

  try {
    const parsed = parseNPAQueryMethodName(options.methodName);

    for (const part of parsed.predicate) {
      const methodProperty = part.condition.property;
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
        ));
        continue;
      }

      if (resolved.missingRelationTarget) {
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNKNOWN_RELATION_TARGET,
          `Relation target "${resolved.missingRelationTarget}" is not available for "${methodProperty}" completion or validation.`,
          methodProperty,
        ));
        continue;
      }

      if (!isOperatorCompatible(part.condition.operator, resolved.property.type)) {
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR,
          `Operator "${part.condition.operator}" is not supported for property "${resolved.path.join(".")}".`,
          methodProperty,
        ));
      }
    }

    for (const order of parsed.orderBy) {
      const orderProperty = getDirectQueryProperties(options.entity).find((property) =>
        property.name === order.property,
      );

      if (!orderProperty) {
        diagnostics.push(error(
          NPAQueryMethodDiagnosticCode.UNSUPPORTED_ORDER_PROPERTY,
          `OrderBy property "${order.property}" must be a direct scalar property on ${options.entity.className}.`,
          order.property,
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

function isOperatorCompatible(
  operator: QueryOperator,
  type: string | undefined,
): boolean {
  const normalized = normalizeType(type);

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

function error(
  code: NPAQueryMethodDiagnosticCode,
  message: string,
  property?: string,
): NPAQueryMethodDiagnostic {
  return {
    code,
    severity: NPAQueryMethodDiagnosticSeverity.ERROR,
    message,
    property,
  };
}
