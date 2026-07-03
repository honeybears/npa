import {
  decodeCursorValues,
  isCursorPageable,
  isOffsetPageable,
  CursorQueryMetadata,
  CursorQueryOrder,
  ParsedQueryMethod,
  QueryCondition,
  QueryOrder,
  QueryPredicatePart,
} from "@node-persistence-api/core";
import { RepositoryMethodInvocation } from "@node-persistence-api/core";
import {
  PostgresqlCompiledQuery,
  PostgresqlQueryCompilerOptions,
} from "./types";
import {
  normalizePropertyValue,
  normalizePropertyValues,
  primaryKeyProperty,
  quoteIdentifier,
} from "./postgresql-identifiers";
import { PostgresqlRelationQueryBuilder } from "./postgresql-relation-query";

export function compilePostgresqlQuery(
  invocation: RepositoryMethodInvocation,
  options: PostgresqlQueryCompilerOptions,
): PostgresqlCompiledQuery {
  const compiler = new QueryCompiler(invocation, options);
  return compiler.compile();
}

class QueryCompiler {
  private readonly values: unknown[] = [];
  private readonly relationQuery = new PostgresqlRelationQueryBuilder(this.options);

  constructor(
    private readonly invocation: RepositoryMethodInvocation,
    private readonly options: PostgresqlQueryCompilerOptions,
  ) {}

  compile(): PostgresqlCompiledQuery {
    const { query } = this.invocation;
    if (this.invocation.select && this.invocation.select.length === 0) {
      throw new Error("Select projection requires at least one property.");
    }

    this.relationQuery.prepare(query, this.invocation.select ?? []);
    const page = this.compilePage(query);
    const from = this.relationQuery.selectFrom();

    switch (query.action) {
      case "find": {
        const where = this.compileWhere(query.predicate, false, query.allIgnoreCase === true);
        const cursorWhere = page?.cursor
          ? this.compileCursorWhere(page.cursor)
          : "";
        const orderBy = page
          ? this.compileOrderBy(page.orders)
          : this.compileOrderBy(query.orderBy);
        const limit = page
          ? this.compilePageLimit(page)
          : this.compileLimit(query);
        const select = page?.selects.length
          ? `${this.selectTarget(query)}, ${page.selects.join(", ")}`
          : this.selectTarget(query);
        const compiled = this.toQuery(
          `SELECT ${select} FROM ${from}${appendWhere(where, cursorWhere)}${orderBy}${limit}`,
        );

        if (page?.cursor) {
          compiled.cursor = page.cursor;
        }

        return compiled;
      }
      case "findOne": {
        const where = this.compileWhere(query.predicate, false, query.allIgnoreCase === true);
        const orderBy = this.compileOrderBy(query.orderBy);
        return this.toQuery(`SELECT ${this.selectTarget(query)} FROM ${from}${where}${orderBy} LIMIT 1`);
      }
      case "exists": {
        const where = this.compileWhere(query.predicate, false, query.allIgnoreCase === true);
        return this.toQuery(
          `SELECT EXISTS(SELECT 1 FROM ${from}${where}) AS "exists"`,
        );
      }
      case "count": {
        const where = this.compileWhere(query.predicate, false, query.allIgnoreCase === true);
        return this.toQuery(
          `SELECT COUNT(${this.countTarget(query)})::int AS "count" FROM ${from}${where}`,
        );
      }
      case "delete":
        return this.toQuery(
          `DELETE FROM ${this.relationQuery.deleteTarget()}${this.relationQuery.deleteUsing()}${this.compileWhere(query.predicate, true, query.allIgnoreCase === true)}`,
        );
    }
  }

  private compileWhere(
    predicate: QueryPredicatePart[],
    includeDeleteJoinPredicates = false,
    allIgnoreCase = false,
  ): string {
    if (predicate.length === 0) {
      const joinPredicates = includeDeleteJoinPredicates
        ? this.relationQuery.deleteJoinPredicates()
        : [];

      return joinPredicates.length > 0
        ? ` WHERE ${joinPredicates.join(" AND ")}`
        : "";
    }

    const groups = groupByOr(predicate);
    const groupSql = groups.map((group) =>
      group
        .map((part) => this.compileCondition(part.condition, allIgnoreCase))
        .join(" AND "),
    );
    const predicateSql = groupSql.map((sql) => `(${sql})`).join(" OR ");
    const joinPredicates = includeDeleteJoinPredicates
      ? this.relationQuery.deleteJoinPredicates()
      : [];

    if (joinPredicates.length > 0) {
      const predicateWithPrecedence = groups.length > 1 ? `(${predicateSql})` : predicateSql;
      return ` WHERE ${[...joinPredicates, predicateWithPrecedence].join(" AND ")}`;
    }

    return ` WHERE ${predicateSql}`;
  }

  private compileCondition(
    condition: QueryCondition,
    allIgnoreCase: boolean,
  ): string {
    const ignoreCase = shouldUseIgnoreCase(condition, allIgnoreCase);
    const columns = this.conditionColumns(condition, ignoreCase);

    if (columns.length > 1) {
      return this.compileCompositeCondition(columns, condition, ignoreCase);
    }

    const column = columns[0];

    switch (condition.operator) {
      case "equals":
        return this.nullableComparison(
          column,
          condition,
          "=",
          "IS NULL",
          (value) => normalizeCaseValue(value, ignoreCase),
        );
      case "not":
        return this.nullableComparison(
          column,
          condition,
          "<>",
          "IS NOT NULL",
          (value) => normalizeCaseValue(value, ignoreCase),
        );
      case "lessThan":
        return `${column} < ${this.value(condition)}`;
      case "lessThanEqual":
        return `${column} <= ${this.value(condition)}`;
      case "greaterThan":
        return `${column} > ${this.value(condition)}`;
      case "greaterThanEqual":
        return `${column} >= ${this.value(condition)}`;
      case "between": {
        const index = requireParameterIndex(condition);
        return `${column} BETWEEN ${this.push(this.normalizeConditionValue(condition, this.arg(condition, index)))} AND ${this.push(
          this.normalizeConditionValue(condition, this.arg(condition, index + 1)),
        )}`;
      }
      case "like":
        return `${column} LIKE ${this.value(condition, (value) => normalizeCaseValue(value, ignoreCase))}`;
      case "startingWith":
        return `${column} LIKE ${this.value(condition, (value) => normalizeCaseValue(`${value}%`, ignoreCase))}`;
      case "endingWith":
        return `${column} LIKE ${this.value(condition, (value) => normalizeCaseValue(`%${value}`, ignoreCase))}`;
      case "containing":
        return `${column} LIKE ${this.value(
          condition,
          (value) => normalizeCaseValue(`%${value}%`, ignoreCase),
        )}`;
      case "in":
        return `${column} = ANY(${this.arrayValue(condition, ignoreCase)})`;
      case "notIn":
        return `${column} <> ALL(${this.arrayValue(condition, ignoreCase)})`;
      case "isNull":
        return `${column} IS NULL`;
      case "isNotNull":
        return `${column} IS NOT NULL`;
      case "true":
        return `${column} IS TRUE`;
      case "false":
        return `${column} IS FALSE`;
    }
  }

  private compileOrderBy(orderBy: QueryOrder[]): string {
    if (orderBy.length === 0) {
      return "";
    }

    const clauses = orderBy.map(
      (order) => `${this.column(order.property)} ${order.direction.toUpperCase()}`,
    );

    return ` ORDER BY ${clauses.join(", ")}`;
  }

  private compileLimit(query: ParsedQueryMethod): string {
    if (query.limit === undefined) {
      return "";
    }

    return ` LIMIT ${query.limit}`;
  }

  private compilePage(query: ParsedQueryMethod): {
    orders: QueryOrder[];
    selects: string[];
    cursor?: CursorQueryMetadata;
    limit: number;
    offset?: number;
  } | undefined {
    const { pageable } = this.invocation;

    if (!pageable) {
      return undefined;
    }

    if (query.limit !== undefined) {
      throw new Error(`Query method "${query.methodName}" cannot combine First/Top with Pageable.`);
    }

    const orders = pageOrders(query.orderBy, primaryKeyProperty(this.options));

    if (isOffsetPageable(pageable)) {
      return {
        orders,
        selects: [],
        limit: pageable.size,
        offset: pageable.page * pageable.size,
      };
    }

    if (!isCursorPageable(pageable)) {
      return undefined;
    }

    const reverse = Boolean(pageable.before);
    const queryOrders = reverse ? reverseOrders(orders) : orders;
    const cursorOrders = queryOrders.map((order, index) => {
      const cursorOrder = this.relationQuery.cursorOrder(
        order.property,
        `__cursor_${index}`,
      );
      const selected = this.invocation.select ?? [];

      if (selected.length > 0 && !cursorOrder.hidden) {
        if (selected.includes(order.property)) {
          return {
            property: order.property,
            direction: order.direction,
            ...cursorOrder,
            resultKey: order.property,
          };
        }

        const resultKey = `__cursor_${index}`;
        return {
          property: order.property,
          direction: order.direction,
          ...cursorOrder,
          resultKey,
          hidden: true,
          select: `${cursorOrder.expression} AS ${quoteIdentifier(resultKey)}`,
        };
      }

      return {
        property: order.property,
        direction: order.direction,
        ...cursorOrder,
      };
    });

    return {
      orders: queryOrders,
      selects: cursorOrders.flatMap((order) => order.select ? [order.select] : []),
      cursor: {
        pageable,
        orders: cursorOrders,
        reverse,
      },
      limit: pageable.size + 1,
    };
  }

  private compilePageLimit(page: { limit: number; offset?: number }): string {
    if (page.offset === undefined) {
      return ` LIMIT ${page.limit}`;
    }

    return ` LIMIT ${page.limit} OFFSET ${page.offset}`;
  }

  private compileCursorWhere(cursor: CursorQueryMetadata): string {
    const token = cursor.pageable.after ?? cursor.pageable.before;

    if (!token) {
      return "";
    }

    const values = decodeCursorValues(token);

    if (values.length !== cursor.orders.length) {
      throw new Error("Invalid cursor.");
    }

    return compileCursorPredicate(cursor.orders, values, (value) => this.push(value));
  }

  private selectTarget(query: ParsedQueryMethod): string {
    if (this.invocation.select?.length) {
      const projection = this.invocation.select.map((property) =>
        `${this.column(property)} AS ${quoteIdentifier(property)}`,
      ).join(", ");
      return query.distinct === true ? `DISTINCT ${projection}` : projection;
    }

    const target = this.relationQuery.selectTarget();
    return query.distinct === true ? `DISTINCT ${target}` : target;
  }

  private countTarget(query: ParsedQueryMethod): string {
    return query.distinct === true
      ? `DISTINCT ${this.relationQuery.countDistinctTarget()}`
      : "*";
  }

  private conditionColumn(
    condition: QueryCondition,
    ignoreCase: boolean,
  ): string {
    return this.conditionColumns(condition, ignoreCase)[0];
  }

  private conditionColumns(
    condition: QueryCondition,
    ignoreCase: boolean,
  ): string[] {
    const columns = this.columns(condition.property);
    return ignoreCase ? columns.map((column) => `LOWER(${column})`) : columns;
  }

  private compileCompositeCondition(
    columns: string[],
    condition: QueryCondition,
    ignoreCase: boolean,
  ): string {
    switch (condition.operator) {
      case "equals":
        return this.compositeComparison(columns, condition, ignoreCase);
      case "not":
        return `NOT (${this.compositeComparison(columns, condition, ignoreCase)})`;
      case "in":
        return this.compositeListCondition(columns, condition, "IN", ignoreCase);
      case "notIn":
        return this.compositeListCondition(columns, condition, "NOT IN", ignoreCase);
      case "isNull":
        return columns.map((column) => `${column} IS NULL`).join(" AND ");
      case "isNotNull":
        return `(${columns.map((column) => `${column} IS NOT NULL`).join(" OR ")})`;
      default:
        throw new Error(
          `Query operator "${condition.operator}" does not support composite property "${condition.property}".`,
        );
    }
  }

  private compositeComparison(
    columns: string[],
    condition: QueryCondition,
    ignoreCase: boolean,
  ): string {
    const values = this.normalizeConditionValues(
      condition,
      this.arg(condition, requireParameterIndex(condition)),
    );

    return columns.map((column, index) => {
      const value = normalizeCaseValue(values[index], ignoreCase);
      return value === null
        ? `${column} IS NULL`
        : `${column} = ${this.push(value)}`;
    }).join(" AND ");
  }

  private compositeListCondition(
    columns: string[],
    condition: QueryCondition,
    operator: "IN" | "NOT IN",
    ignoreCase: boolean,
  ): string {
    const value = this.arg(condition, requireParameterIndex(condition));

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

    const placeholders = value.map((item) => {
      const values = this.normalizeConditionValues(condition, item);
      return `(${values.map((part) =>
        this.push(normalizeCaseValue(part, ignoreCase)),
      ).join(", ")})`;
    }).join(", ");

    return `${tupleExpression(columns)} ${operator} (${placeholders})`;
  }

  private value(
    condition: QueryCondition,
    transform: (value: unknown) => unknown = (value) => value,
  ): string {
    const value = this.normalizeConditionValue(
      condition,
      this.arg(condition, requireParameterIndex(condition)),
    );
    return this.push(transform(value));
  }

  private nullableComparison(
    column: string,
    condition: QueryCondition,
    operator: "=" | "<>",
    nullSql: "IS NULL" | "IS NOT NULL",
    transform: (value: unknown) => unknown,
  ): string {
    const value = this.normalizeConditionValue(
      condition,
      this.arg(condition, requireParameterIndex(condition)),
    );

    if (value === null) {
      return `${column} ${nullSql}`;
    }

    return `${column} ${operator} ${this.push(transform(value))}`;
  }

  private normalizeConditionValue(condition: QueryCondition, value: unknown): unknown {
    return normalizePropertyValue(condition.property, value, this.options);
  }

  private normalizeConditionValues(condition: QueryCondition, value: unknown): unknown[] {
    return normalizePropertyValues(condition.property, value, this.options);
  }

  private arrayValue(condition: QueryCondition, ignoreCase: boolean): string {
    const value = this.arg(condition, requireParameterIndex(condition));

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

    return this.push(value.map((item) =>
      normalizeCaseValue(this.normalizeConditionValue(condition, item), ignoreCase),
    ));
  }

  private column(property: string): string {
    return this.relationQuery.column(property);
  }

  private columns(property: string): string[] {
    return this.relationQuery.columns(property);
  }

  private arg(condition: QueryCondition, index: number): unknown {
    const value = this.invocation.args[index];

    if (value === undefined) {
      throw new Error(
        `Query method "${this.invocation.query.methodName}" parameter for "${condition.property}" must not be undefined.`,
      );
    }

    return value;
  }

  private push(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  private toQuery(text: string): PostgresqlCompiledQuery {
    return { text, values: this.values };
  }
}

function appendWhere(where: string, extra: string): string {
  if (!extra) {
    return where;
  }

  if (!where) {
    return ` WHERE ${extra}`;
  }

  return `${where} AND ${extra}`;
}

function pageOrders(orderBy: QueryOrder[], primaryKey: string): QueryOrder[] {
  const orders = orderBy.length > 0
    ? orderBy
    : [{ property: primaryKey, direction: "asc" as const }];

  return orders.some((order) => order.property === primaryKey)
    ? orders
    : [...orders, { property: primaryKey, direction: "asc" }];
}

function reverseOrders(orderBy: QueryOrder[]): QueryOrder[] {
  return orderBy.map((order) => ({
    ...order,
    direction: order.direction === "asc" ? "desc" : "asc",
  }));
}

function tupleExpression(columns: string[]): string {
  return columns.length === 1 ? columns[0] : `(${columns.join(", ")})`;
}

function compileCursorPredicate(
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

function groupByOr(predicate: QueryPredicatePart[]): QueryPredicatePart[][] {
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

function requireParameterIndex(condition: QueryCondition): number {
  if (condition.parameterIndex === undefined) {
    throw new Error(`Query operator "${condition.operator}" has no parameter.`);
  }

  return condition.parameterIndex;
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

function normalizeCaseValue(value: unknown, ignoreCase: boolean): unknown {
  return ignoreCase && typeof value === "string" ? value.toLowerCase() : value;
}
