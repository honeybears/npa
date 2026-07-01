import {
  ParsedQueryMethod,
  QueryCondition,
  QueryOrder,
  QueryPredicatePart,
} from "@honeybeaers/npa";
import { RepositoryMethodInvocation } from "@honeybeaers/npa";
import {
  PostgresqlCompiledQuery,
  PostgresqlQueryCompilerOptions,
} from "./types";
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
        const where = this.compileWhere(query.predicate);
        const orderBy = this.compileOrderBy(query.orderBy);
        const limit = this.compileLimit(query);
        return this.toQuery(`SELECT ${this.relationQuery.selectTarget()} FROM ${from}${where}${orderBy}${limit}`);
      }
      case "findOne": {
        const where = this.compileWhere(query.predicate);
        const orderBy = this.compileOrderBy(query.orderBy);
        return this.toQuery(`SELECT ${this.relationQuery.selectTarget()} FROM ${from}${where}${orderBy} LIMIT 1`);
      }
      case "exists": {
        const where = this.compileWhere(query.predicate);
        return this.toQuery(
          `SELECT EXISTS(SELECT 1 FROM ${from}${where}) AS "exists"`,
        );
      }
      case "count": {
        const where = this.compileWhere(query.predicate);
        return this.toQuery(
          `SELECT COUNT(*)::int AS "count" FROM ${from}${where}`,
        );
      }
      case "delete":
        return this.toQuery(
          `DELETE FROM ${this.relationQuery.deleteTarget()}${this.relationQuery.deleteUsing()}${this.compileWhere(query.predicate, true)}`,
        );
    }
  }

  private compileWhere(
    predicate: QueryPredicatePart[],
    includeDeleteJoinPredicates = false,
  ): string {
    const groups = groupByOr(predicate);
    const groupSql = groups.map((group) =>
      group
        .map((part) => this.compileCondition(part.condition))
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

  private compileCondition(condition: QueryCondition): string {
    const column = this.column(condition.property);

    switch (condition.operator) {
      case "equals":
        return `${column} = ${this.value(condition)}`;
      case "not":
        return `${column} <> ${this.value(condition)}`;
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
        return `${column} BETWEEN ${this.push(this.arg(index))} AND ${this.push(
          this.arg(index + 1),
        )}`;
      }
      case "like":
        return `${column} LIKE ${this.value(condition)}`;
      case "startingWith":
        return `${column} LIKE ${this.value(condition, (value) => `${value}%`)}`;
      case "endingWith":
        return `${column} LIKE ${this.value(condition, (value) => `%${value}`)}`;
      case "containing":
        return `${column} LIKE ${this.value(
          condition,
          (value) => `%${value}%`,
        )}`;
      case "in":
        return `${column} = ANY(${this.arrayValue(condition)})`;
      case "notIn":
        return `${column} <> ALL(${this.arrayValue(condition)})`;
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

  private value(
    condition: QueryCondition,
    transform: (value: unknown) => unknown = (value) => value,
  ): string {
    return this.push(transform(this.arg(requireParameterIndex(condition))));
  }

  private arrayValue(condition: QueryCondition): string {
    const value = this.arg(requireParameterIndex(condition));

    if (!Array.isArray(value)) {
      throw new Error(
        `Query operator "${condition.operator}" expects an array parameter.`,
      );
    }

    return this.push(value);
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
