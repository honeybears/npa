import {
  appendWhere,
  compileCursorPredicate,
  decodeCursorValues,
  groupByOr,
  isCursorPageable,
  isOffsetPageable,
  normalizeCaseValue,
  CursorQueryMetadata,
  NPAPaginationError,
  NPAQueryError,
  pageOrders,
  ParsedQueryMethod,
  QueryCondition,
  QueryOrder,
  QueryPredicatePart,
  requireParameterIndex,
  reverseOrders,
  shouldUseIgnoreCase,
  tupleExpression,
} from "@node-persistence-api/core";
import { RepositoryMethodInvocation } from "@node-persistence-api/core";
import {
  mysqlPrimaryKeyProperty,
  normalizeMysqlPropertyValue,
  normalizeMysqlPropertyValues,
} from "./mysql-identifiers";
import { MysqlRelationQueryBuilder } from "./mysql-relation-query";
import { MysqlCompiledQuery, MysqlQueryCompilerOptions } from "./types";

export function compileMysqlQuery(
  invocation: RepositoryMethodInvocation,
  options: MysqlQueryCompilerOptions,
): MysqlCompiledQuery {
  const compiler = new MysqlQueryCompiler(invocation, options);
  return compiler.compile();
}

class MysqlQueryCompiler {
  private readonly values: unknown[] = [];
  private readonly relationQuery = new MysqlRelationQueryBuilder(this.options);

  constructor(
    private readonly invocation: RepositoryMethodInvocation,
    private readonly options: MysqlQueryCompilerOptions,
  ) {}

  compile(): MysqlCompiledQuery {
    const { query } = this.invocation;

    this.relationQuery.prepare(query);
    const page = this.compilePage(query);
    const from = this.relationQuery.selectFrom();

    switch (query.action) {
      case "find": {
        const where = this.compileWhere(query.predicate, query.allIgnoreCase === true);
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
        const where = this.compileWhere(query.predicate, query.allIgnoreCase === true);
        const orderBy = this.compileOrderBy(query.orderBy);
        return this.toQuery(`SELECT ${this.selectTarget(query)} FROM ${from}${where}${orderBy} LIMIT 1`);
      }
      case "exists": {
        const where = this.compileWhere(query.predicate, query.allIgnoreCase === true);
        return this.toQuery(
          `SELECT EXISTS(SELECT 1 FROM ${from}${where}) AS \`exists\``,
        );
      }
      case "count": {
        const where = this.compileWhere(query.predicate, query.allIgnoreCase === true);
        return this.toQuery(
          `SELECT COUNT(${this.countTarget(query)}) AS \`count\` FROM ${from}${where}`,
        );
      }
      case "delete":
        return this.toQuery(
          `DELETE ${this.relationQuery.deleteTarget()}FROM ${from}${this.compileWhere(query.predicate, query.allIgnoreCase === true)}`,
        );
    }
  }

  private compileWhere(
    predicate: QueryPredicatePart[],
    allIgnoreCase = false,
  ): string {
    if (predicate.length === 0) {
      return "";
    }

    const groups = groupByOr(predicate);
    const groupSql = groups.map((group) =>
      group
        .map((part) => this.compileCondition(part.condition, allIgnoreCase))
        .join(" AND "),
    );

    return ` WHERE ${groupSql.map((sql) => `(${sql})`).join(" OR ")}`;
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
        return this.listCondition(column, condition, "IN", ignoreCase);
      case "notIn":
        return this.listCondition(column, condition, "NOT IN", ignoreCase);
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

  private listCondition(
    column: string,
    condition: QueryCondition,
    operator: "IN" | "NOT IN",
    ignoreCase: boolean,
  ): string {
    const value = this.arg(condition, requireParameterIndex(condition));

    if (!Array.isArray(value)) {
      throw new NPAQueryError(
        `Query operator "${condition.operator}" expects an array parameter.`,
        {
          code: "NPA_INVALID_QUERY_PREDICATE",
          details: { operator: condition.operator },
        },
      );
    }

    if (value.length === 0) {
      throw new NPAQueryError(
        `Query operator "${condition.operator}" expects a non-empty array parameter.`,
        {
          code: "NPA_INVALID_QUERY_PREDICATE",
          details: { operator: condition.operator },
        },
      );
    }

    const placeholders = value
      .map((item) => this.push(
        normalizeCaseValue(this.normalizeConditionValue(condition, item), ignoreCase),
      ))
      .join(", ");
    return `${column} ${operator} (${placeholders})`;
  }

  private compileOrderBy(orderBy: QueryOrder[]): string {
    if (orderBy.length === 0) {
      return "";
    }

    const clauses = orderBy.map(
      (order) =>
        `${this.column(order.property)} ${order.direction.toUpperCase()}`,
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
      throw new NPAQueryError(`Query method "${query.methodName}" cannot combine First/Top with Pageable.`, {
        code: "NPA_TOP_PAGEABLE_CONFLICT",
        details: { methodName: query.methodName },
      });
    }

    const orders = pageOrders(query.orderBy, mysqlPrimaryKeyProperty(this.options));

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
      throw new NPAPaginationError("Invalid cursor.", {
        code: "NPA_INVALID_CURSOR",
      });
    }

    return compileCursorPredicate(cursor.orders, values, (value) => this.push(value));
  }

  private selectTarget(query: ParsedQueryMethod): string {
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
    return normalizeMysqlPropertyValue(condition.property, value, this.options);
  }

  private normalizeConditionValues(condition: QueryCondition, value: unknown): unknown[] {
    return normalizeMysqlPropertyValues(condition.property, value, this.options);
  }

  private arg(condition: QueryCondition, index: number): unknown {
    const value = this.invocation.args[index];

    if (value === undefined) {
      throw new NPAQueryError(
        `Query method "${this.invocation.query.methodName}" parameter for "${condition.property}" must not be undefined.`,
        {
          code: "NPA_INVALID_QUERY_PREDICATE",
          details: { methodName: this.invocation.query.methodName, property: condition.property },
        },
      );
    }

    return value;
  }

  private push(value: unknown): string {
    this.values.push(value);
    return "?";
  }

  private column(property: string): string {
    return this.relationQuery.column(property);
  }

  private columns(property: string): string[] {
    return this.relationQuery.columns(property);
  }

  private toQuery(text: string): MysqlCompiledQuery {
    return { text, values: this.values };
  }
}
