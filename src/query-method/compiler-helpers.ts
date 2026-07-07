import { NPAQueryError } from "../error";
import type { CursorQueryOrder } from "../repository/pagination";
import type {
  QueryCondition,
  QueryOrder,
  QueryPredicatePart,
} from "./types";

export function appendWhere(where: string, extra: string): string {
  if (!extra) {
    return where;
  }

  if (!where) {
    return ` WHERE ${extra}`;
  }

  return `${where} AND ${extra}`;
}

export function pageOrders(orderBy: QueryOrder[], primaryKey: string): QueryOrder[] {
  const orders = orderBy.length > 0
    ? orderBy
    : [{ property: primaryKey, direction: "asc" as const }];

  return orders.some((order) => order.property === primaryKey)
    ? orders
    : [...orders, { property: primaryKey, direction: "asc" }];
}

export function reverseOrders(orderBy: QueryOrder[]): QueryOrder[] {
  return orderBy.map((order) => ({
    ...order,
    direction: order.direction === "asc" ? "desc" : "asc",
  }));
}

export function tupleExpression(columns: string[]): string {
  return columns.length === 1 ? columns[0] : `(${columns.join(", ")})`;
}

export function compileCursorPredicate(
  orders: CursorQueryOrder[],
  values: unknown[],
  push: (value: unknown) => string,
): string {
  const groups = orders.map((order, index) => {
    const equals = orders
      .slice(0, index)
      .map((previous, previousIndex) =>
        `${previous.expression} = ${push(values[previousIndex])}`,
      );
    const operator = order.direction === "asc" ? ">" : "<";
    return [
      ...equals,
      `${order.expression} ${operator} ${push(values[index])}`,
    ].join(" AND ");
  });

  return `(${groups.map((group) => `(${group})`).join(" OR ")})`;
}

export function groupByOr(predicate: QueryPredicatePart[]): QueryPredicatePart[][] {
  const groups: QueryPredicatePart[][] = [[]];

  for (const part of predicate) {
    if (part.connector === "or") {
      groups.push([part]);
      continue;
    }

    groups[groups.length - 1].push(part);
  }

  return groups;
}

export function requireParameterIndex(condition: QueryCondition): number {
  if (condition.parameterIndex === undefined) {
    throw new NPAQueryError(`Query operator "${condition.operator}" has no parameter.`, {
      code: "NPA_INVALID_QUERY_PREDICATE",
      details: { operator: condition.operator },
    });
  }

  return condition.parameterIndex;
}

export function shouldUseIgnoreCase(
  condition: QueryCondition,
  allIgnoreCase: boolean,
): boolean {
  return Boolean(
    (condition.ignoreCase || allIgnoreCase) &&
      [
        "equals",
        "not",
        "like",
        "startingWith",
        "endingWith",
        "containing",
        "in",
        "notIn",
      ].includes(condition.operator),
  );
}

export function normalizeCaseValue(value: unknown, ignoreCase: boolean): unknown {
  return ignoreCase && typeof value === "string" ? value.toLowerCase() : value;
}
