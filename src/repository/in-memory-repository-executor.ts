import {
  QueryCondition,
  QueryOrder,
  QueryPredicatePart,
} from "../query-method";
import {
  createCursorWindow,
  createPage,
  decodeCursorValues,
  isCursorPageable,
  isOffsetPageable,
  type CursorQueryMetadata,
} from "./pagination";
import { RepositoryMethodInvocation } from "./types";

export class InMemoryRepositoryExecutor<TEntity extends object> {
  constructor(private readonly rows: TEntity[]) {}

  execute = ({ query, args, pageable, select }: RepositoryMethodInvocation): unknown => {
    if (select && select.length === 0) {
      throw new Error("Select projection requires at least one property.");
    }

    const matchedRows = this.rows.filter((row) =>
      matchesPredicate(row, query.predicate, args, query.allIgnoreCase === true),
    );
    const resultRows = query.distinct === true ? distinctRows(matchedRows) : matchedRows;

    if (query.action === "delete") {
      return this.deleteRows(matchedRows);
    }

    const sortedRows = sortRows(resultRows, query.orderBy);
    const selectedRows = pageable
      ? applyPageable(sortedRows, query.orderBy, pageable)
      : applyLimit(sortedRows, query.limit);
    const projectedRows = select?.length
      ? selectedRows.map((row) => projectRow(row, select))
      : selectedRows;

    switch (query.action) {
      case "find":
        if (pageable && isOffsetPageable(pageable)) {
          return createPage(projectedRows, pageable, resultRows.length);
        }

        if (pageable && isCursorPageable(pageable)) {
          const window = createCursorWindow(
            selectedRows,
            cursorMetadata(query.orderBy, pageable),
          );

          return select?.length
            ? { ...window, content: window.content.map((row) => projectRow(row, select)) }
            : window;
        }

        return projectedRows;
      case "findOne":
        return projectedRows[0] ?? null;
      case "exists":
        return matchedRows.length > 0;
      case "count":
        return resultRows.length;
    }
  };

  private deleteRows(rowsToDelete: TEntity[]): number {
    const targets = new Set(rowsToDelete);
    let deletedCount = 0;

    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (!targets.has(this.rows[index])) {
        continue;
      }

      this.rows.splice(index, 1);
      deletedCount += 1;
    }

    return deletedCount;
  }
}

function matchesPredicate<TEntity extends object>(
  row: TEntity,
  predicate: QueryPredicatePart[],
  args: unknown[],
  allIgnoreCase: boolean,
): boolean {
  const groups = groupByOr(predicate);

  return groups.some((group) =>
    group.every((part) =>
      matchesCondition(row, part.condition, args, allIgnoreCase),
    ),
  );
}

function groupByOr(
  predicate: QueryPredicatePart[],
): QueryPredicatePart[][] {
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

function matchesCondition<TEntity extends object>(
  row: TEntity,
  condition: QueryCondition,
  args: unknown[],
  allIgnoreCase: boolean,
): boolean {
  const ignoreCase = shouldUseIgnoreCase(condition, allIgnoreCase);
  const actual = normalizeCaseValue(getProperty(row, condition.property), ignoreCase);
  const expected = normalizeExpected(readArgument(condition, args), ignoreCase);

  switch (condition.operator) {
    case "equals":
      assertDefinedQueryParameter(condition, expected);
      return expected === null
        ? actual === null || actual === undefined
        : actual === expected;
    case "not":
      assertDefinedQueryParameter(condition, expected);
      return expected === null
        ? actual !== null && actual !== undefined
        : actual !== expected;
    case "lessThan":
      assertDefinedQueryParameter(condition, expected);
      return compare(actual, expected) < 0;
    case "lessThanEqual":
      assertDefinedQueryParameter(condition, expected);
      return compare(actual, expected) <= 0;
    case "greaterThan":
      assertDefinedQueryParameter(condition, expected);
      return compare(actual, expected) > 0;
    case "greaterThanEqual":
      assertDefinedQueryParameter(condition, expected);
      return compare(actual, expected) >= 0;
    case "between":
      if (!isBetweenArgument(expected)) {
        return false;
      }

      assertDefinedQueryParameter(condition, expected[0]);
      assertDefinedQueryParameter(condition, expected[1]);
      return (
        compare(actual, expected[0]) >= 0 && compare(actual, expected[1]) <= 0
      );
    case "like":
      assertDefinedQueryParameter(condition, expected);
      return matchesLike(actual, expected);
    case "startingWith":
      assertDefinedQueryParameter(condition, expected);
      return String(actual).startsWith(String(expected));
    case "endingWith":
      assertDefinedQueryParameter(condition, expected);
      return String(actual).endsWith(String(expected));
    case "containing":
      assertDefinedQueryParameter(condition, expected);
      return String(actual).includes(String(expected));
    case "in":
      assertNonEmptyArrayQueryParameter(condition, expected);
      return expected.includes(actual);
    case "notIn":
      assertNonEmptyArrayQueryParameter(condition, expected);
      return !expected.includes(actual);
    case "isNull":
      return actual === null || actual === undefined;
    case "isNotNull":
      return actual !== null && actual !== undefined;
    case "true":
      return actual === true;
    case "false":
      return actual === false;
  }
}

function readArgument(
  condition: QueryCondition,
  args: unknown[],
): unknown | [unknown, unknown] {
  if (condition.parameterIndex === undefined) {
    return undefined;
  }

  if (condition.operator === "between") {
    return [args[condition.parameterIndex], args[condition.parameterIndex + 1]];
  }

  return args[condition.parameterIndex];
}

function isBetweenArgument(value: unknown): value is [unknown, unknown] {
  return Array.isArray(value) && value.length === 2;
}

function assertDefinedQueryParameter(
  condition: QueryCondition,
  value: unknown,
): void {
  if (value === undefined) {
    throw new Error(
      `Query parameter for "${condition.property}" must not be undefined.`,
    );
  }
}

function assertNonEmptyArrayQueryParameter(
  condition: QueryCondition,
  value: unknown,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Query operator "${condition.operator}" expects an array parameter.`,
    );
  }

  if (value.length === 0) {
    throw new Error(
      `Query operator "${condition.operator}" expects a non-empty array parameter.`,
    );
  }
}

function sortRows<TEntity extends object>(
  rows: TEntity[],
  orderBy: QueryOrder[],
): TEntity[] {
  if (orderBy.length === 0) {
    return rows;
  }

  return [...rows].sort((left, right) => {
    for (const order of orderBy) {
      const result = compare(
        getProperty(left, order.property),
        getProperty(right, order.property),
      );

      if (result !== 0) {
        return order.direction === "asc" ? result : -result;
      }
    }

    return 0;
  });
}

function applyLimit<TEntity>(rows: TEntity[], limit: number | undefined) {
  return limit === undefined ? rows : rows.slice(0, limit);
}

function applyPageable<TEntity extends object>(
  rows: TEntity[],
  orderBy: QueryOrder[],
  pageable: NonNullable<RepositoryMethodInvocation["pageable"]>,
): TEntity[] {
  const orders = pageOrders(orderBy);
  const sortedRows = sortRows(rows, orders);

  if (isOffsetPageable(pageable)) {
    const offset = pageable.page * pageable.size;
    return sortedRows.slice(offset, offset + pageable.size);
  }

  const cursor = pageable.after ?? pageable.before;
  const reverse = Boolean(pageable.before);
  const effectiveOrders = reverse ? reverseOrders(orders) : orders;
  const effectiveRows = reverse ? sortRows(rows, effectiveOrders) : sortedRows;
  const filteredRows = cursor
    ? effectiveRows.filter((row) =>
      isAfterCursor(row, effectiveOrders, decodeCursorValues(cursor)),
    )
    : effectiveRows;

  return filteredRows.slice(0, pageable.size + 1);
}

function cursorMetadata(
  orderBy: QueryOrder[],
  pageable: NonNullable<RepositoryMethodInvocation["pageable"]>,
): CursorQueryMetadata {
  if (!isCursorPageable(pageable)) {
    throw new Error("Cursor metadata requires cursor pagination.");
  }

  return {
    pageable,
    orders: pageOrders(orderBy).map((order) => ({
      ...order,
      expression: order.property,
      resultKey: order.property,
    })),
    reverse: Boolean(pageable.before),
  };
}

function pageOrders(orderBy: QueryOrder[]): QueryOrder[] {
  const orders = orderBy.length > 0 ? orderBy : [{ property: "id", direction: "asc" as const }];

  return orders.some((order) => order.property === "id")
    ? orders
    : [...orders, { property: "id", direction: "asc" }];
}

function reverseOrders(orderBy: QueryOrder[]): QueryOrder[] {
  return orderBy.map((order) => ({
    ...order,
    direction: order.direction === "asc" ? "desc" : "asc",
  }));
}

function isAfterCursor<TEntity extends object>(
  row: TEntity,
  orderBy: QueryOrder[],
  cursorValues: unknown[],
): boolean {
  for (let index = 0; index < orderBy.length; index += 1) {
    const order = orderBy[index];
    const result = compare(getProperty(row, order.property), cursorValues[index]);

    if (result === 0) {
      continue;
    }

    return order.direction === "asc" ? result > 0 : result < 0;
  }

  return false;
}

function distinctRows<TEntity>(rows: TEntity[]): TEntity[] {
  return [...new Set(rows)];
}

function projectRow<TEntity extends object>(
  row: TEntity,
  select: readonly string[],
): Partial<TEntity> {
  const record = row as Record<string, unknown>;
  return Object.fromEntries(
    select.map((property) => [property, record[property]]),
  ) as Partial<TEntity>;
}

function getProperty<TEntity extends object>(
  row: TEntity,
  property: string,
): unknown {
  return (row as Record<string, unknown>)[property];
}

function compare(left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }

  if (left instanceof Date && right instanceof Date) {
    return Math.sign(left.getTime() - right.getTime());
  }

  if (left === null || left === undefined) {
    return -1;
  }

  if (right === null || right === undefined) {
    return 1;
  }

  return left < right ? -1 : 1;
}

function matchesLike(actual: unknown, pattern: unknown): boolean {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = escaped.replace(/%/g, ".*").replace(/_/g, ".");

  return new RegExp(`^${expression}$`).test(String(actual));
}

function shouldUseIgnoreCase(
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

function normalizeExpected(value: unknown, ignoreCase: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCaseValue(item, ignoreCase));
  }

  return normalizeCaseValue(value, ignoreCase);
}

function normalizeCaseValue(value: unknown, ignoreCase: boolean): unknown {
  return ignoreCase && typeof value === "string" ? value.toLowerCase() : value;
}
