import {
  QueryCondition,
  QueryOrder,
  QueryPredicatePart,
} from "../query-method";
import { RepositoryMethodInvocation } from "./types";

export class InMemoryRepositoryExecutor<TEntity extends object> {
  constructor(private readonly rows: TEntity[]) {}

  execute = ({ query, args }: RepositoryMethodInvocation): unknown => {
    const matchedRows = this.rows.filter((row) =>
      matchesPredicate(row, query.predicate, args, query.allIgnoreCase === true),
    );
    const resultRows = query.distinct === true ? distinctRows(matchedRows) : matchedRows;

    if (query.action === "delete") {
      return this.deleteRows(matchedRows);
    }

    const selectedRows = applyLimit(
      sortRows(resultRows, query.orderBy),
      query.limit,
    );

    switch (query.action) {
      case "find":
        return selectedRows;
      case "findOne":
        return selectedRows[0] ?? null;
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
      return actual === expected;
    case "not":
      return actual !== expected;
    case "lessThan":
      return compare(actual, expected) < 0;
    case "lessThanEqual":
      return compare(actual, expected) <= 0;
    case "greaterThan":
      return compare(actual, expected) > 0;
    case "greaterThanEqual":
      return compare(actual, expected) >= 0;
    case "between":
      if (!isBetweenArgument(expected)) {
        return false;
      }

      return (
        compare(actual, expected[0]) >= 0 && compare(actual, expected[1]) <= 0
      );
    case "like":
      return matchesLike(actual, expected);
    case "startingWith":
      return String(actual).startsWith(String(expected));
    case "endingWith":
      return String(actual).endsWith(String(expected));
    case "containing":
      return String(actual).includes(String(expected));
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "notIn":
      return Array.isArray(expected) && !expected.includes(actual);
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

function distinctRows<TEntity>(rows: TEntity[]): TEntity[] {
  return [...new Set(rows)];
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
