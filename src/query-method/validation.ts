import { NPAQueryError } from "../error";
import { ParsedQueryMethod, QueryPredicatePart } from "./types";

export interface DuplicateQueryPredicate {
  key: string;
  property: string;
  operator: string;
  ignoreCase: boolean;
  firstIndex: number;
  duplicateIndex: number;
  first: QueryPredicatePart;
  duplicate: QueryPredicatePart;
}

export function findDuplicateQueryPredicates(
  query: ParsedQueryMethod,
): DuplicateQueryPredicate[] {
  const seen = new Map<string, { index: number; part: QueryPredicatePart }>();
  const duplicates: DuplicateQueryPredicate[] = [];

  query.predicate.forEach((part, index) => {
    const key = predicateKey(part, query.allIgnoreCase === true);
    const current = seen.get(key);

    if (current) {
      duplicates.push({
        key,
        property: part.condition.property,
        operator: part.condition.operator,
        ignoreCase: usesIgnoreCase(part, query.allIgnoreCase === true),
        firstIndex: current.index,
        duplicateIndex: index,
        first: current.part,
        duplicate: part,
      });
      return;
    }

    seen.set(key, { index, part });
  });

  return duplicates;
}

export function hasDuplicateQueryPredicates(query: ParsedQueryMethod): boolean {
  return findDuplicateQueryPredicates(query).length > 0;
}

export function assertNoDuplicateQueryPredicates(query: ParsedQueryMethod): void {
  const duplicate = findDuplicateQueryPredicates(query)[0];

  if (!duplicate) {
    return;
  }

  throw new NPAQueryError(
    `Query method "${query.methodName}" contains duplicate predicate "${formatPredicate(duplicate)}". ` +
      "Use a different operator or an In/NotIn query instead.",
    {
      code: "NPA_DUPLICATE_QUERY_PREDICATE",
      details: {
        methodName: query.methodName,
        predicate: formatPredicate(duplicate),
        firstIndex: duplicate.firstIndex,
        duplicateIndex: duplicate.duplicateIndex,
      },
    },
  );
}

function predicateKey(part: QueryPredicatePart, allIgnoreCase: boolean): string {
  return [
    part.condition.property,
    part.condition.operator,
    usesIgnoreCase(part, allIgnoreCase) ? "ignore-case" : "case-sensitive",
  ].join(":");
}

function usesIgnoreCase(part: QueryPredicatePart, allIgnoreCase: boolean): boolean {
  return part.condition.ignoreCase === true || allIgnoreCase;
}

function formatPredicate(duplicate: DuplicateQueryPredicate): string {
  return [
    duplicate.property,
    duplicate.operator,
    duplicate.ignoreCase ? "ignoreCase" : undefined,
  ].filter(Boolean).join(" ");
}
