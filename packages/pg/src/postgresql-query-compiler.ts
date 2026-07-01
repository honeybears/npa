import {
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
import { normalizePropertyValue } from "./postgresql-identifiers";
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
    this.relationQuery.prepare(query);
    const from = this.relationQuery.selectFrom();

    switch (query.action) {
      case "find": {
        const where = this.compileWhere(query.predicate, false, query.allIgnoreCase === true);
        const orderBy = this.compileOrderBy(query.orderBy);
        const limit = this.compileLimit(query);
        return this.toQuery(`SELECT ${this.selectTarget(query)} FROM ${from}${where}${orderBy}${limit}`);
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
    const column = this.conditionColumn(condition, ignoreCase);

    switch (condition.operator) {
      case "equals":
        return `${column} = ${this.value(condition, (value) => normalizeCaseValue(value, ignoreCase))}`;
      case "not":
        return `${column} <> ${this.value(condition, (value) => normalizeCaseValue(value, ignoreCase))}`;
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
        return `${column} BETWEEN ${this.push(this.normalizeConditionValue(condition, this.arg(index)))} AND ${this.push(
          this.normalizeConditionValue(condition, this.arg(index + 1)),
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
    const column = this.column(condition.property);
    return ignoreCase ? `LOWER(${column})` : column;
  }

  private value(
    condition: QueryCondition,
    transform: (value: unknown) => unknown = (value) => value,
  ): string {
    const value = this.normalizeConditionValue(
      condition,
      this.arg(requireParameterIndex(condition)),
    );
    return this.push(transform(value));
  }

  private normalizeConditionValue(condition: QueryCondition, value: unknown): unknown {
    return normalizePropertyValue(condition.property, value, this.options);
  }

  private arrayValue(condition: QueryCondition, ignoreCase: boolean): string {
    const value = this.arg(requireParameterIndex(condition));

    if (!Array.isArray(value)) {
      throw new Error(
        `Query operator "${condition.operator}" expects an array parameter.`,
      );
    }

    return this.push(value.map((item) =>
      normalizeCaseValue(this.normalizeConditionValue(condition, item), ignoreCase),
    ));
  }

  private column(property: string): string {
    return this.relationQuery.column(property);
  }

  private arg(index: number): unknown {
    return this.invocation.args[index];
  }

  private push(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  private toQuery(text: string): PostgresqlCompiledQuery {
    return { text, values: this.values };
  }
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
