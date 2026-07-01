import {
  ParsedQueryMethod,
  QueryCondition,
  QueryOrder,
  QueryPredicatePart,
} from "@honeybeaers/npa";
import { RepositoryMethodInvocation } from "@honeybeaers/npa";
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
          `SELECT EXISTS(SELECT 1 FROM ${from}${where}) AS \`exists\``,
        );
      }
      case "count": {
        const where = this.compileWhere(query.predicate);
        return this.toQuery(
          `SELECT COUNT(*) AS \`count\` FROM ${from}${where}`,
        );
      }
      case "delete":
        return this.toQuery(
          `DELETE ${this.relationQuery.deleteTarget()}FROM ${from}${this.compileWhere(query.predicate)}`,
        );
    }
  }

  private compileWhere(predicate: QueryPredicatePart[]): string {
    const groups = groupByOr(predicate);
    const groupSql = groups.map((group) =>
      group
        .map((part) => this.compileCondition(part.condition))
        .join(" AND "),
    );

    return ` WHERE ${groupSql.map((sql) => `(${sql})`).join(" OR ")}`;
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
        return this.listCondition(column, condition, "IN", "0 = 1");
      case "notIn":
        return this.listCondition(column, condition, "NOT IN", "1 = 1");
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
    emptySql: string,
  ): string {
    const value = this.arg(requireParameterIndex(condition));

    if (!Array.isArray(value)) {
      throw new Error(
        `Query operator "${condition.operator}" expects an array parameter.`,
      );
    }

    if (value.length === 0) {
      return emptySql;
    }

    const placeholders = value.map((item) => this.push(item)).join(", ");
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

  private value(
    condition: QueryCondition,
    transform: (value: unknown) => unknown = (value) => value,
  ): string {
    return this.push(transform(this.arg(requireParameterIndex(condition))));
  }

  private arg(index: number): unknown {
    return this.invocation.args[index];
  }

  private push(value: unknown): string {
    this.values.push(value);
    return "?";
  }

  private column(property: string): string {
    return this.relationQuery.column(property);
  }

  private toQuery(text: string): MysqlCompiledQuery {
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
