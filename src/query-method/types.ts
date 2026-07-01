export type QueryMethodAction =
  | "find"
  | "findOne"
  | "exists"
  | "count"
  | "delete";

export type QueryOperator =
  | "equals"
  | "not"
  | "lessThan"
  | "lessThanEqual"
  | "greaterThan"
  | "greaterThanEqual"
  | "between"
  | "like"
  | "startingWith"
  | "endingWith"
  | "containing"
  | "in"
  | "notIn"
  | "isNull"
  | "isNotNull"
  | "true"
  | "false";

export type QueryLogicalOperator = "and" | "or";

export interface QueryCondition {
  property: string;
  operator: QueryOperator;
  parameterIndex?: number;
  ignoreCase?: boolean;
}

export interface QueryPredicatePart {
  connector?: QueryLogicalOperator;
  condition: QueryCondition;
}

export interface QueryOrder {
  property: string;
  direction: "asc" | "desc";
}

export interface ParsedQueryMethod {
  methodName: string;
  action: QueryMethodAction;
  distinct?: boolean;
  allIgnoreCase?: boolean;
  limit?: number;
  predicate: QueryPredicatePart[];
  orderBy: QueryOrder[];
  parameterCount: number;
}

export interface QueryMethodExecutor<TResult = unknown> {
  (query: ParsedQueryMethod, args: unknown[]): TResult;
}
