import { NPAQueryError } from "../error";
import { isPageable } from "../repository/pagination";
import { parseQueryMethod } from "./parse-query-method";
import { QueryMethodExecutor } from "./types";
import { assertNoDuplicateQueryPredicates } from "./validation";

export function createQueryMethodProxy<TTarget extends object>(
  target: TTarget,
  executor: QueryMethodExecutor,
): TTarget {
  return new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (typeof property !== "string" || property in currentTarget) {
        return Reflect.get(currentTarget, property, receiver);
      }

      return (...args: unknown[]) => {
        const query = parseQueryMethod(property);
        assertNoDuplicateQueryPredicates(query);
        const { queryArgs, pageable } = splitQueryArgs(property, query, args);

        return executor(query, queryArgs, pageable);
      };
    },
  });
}

function splitQueryArgs(
  methodName: string,
  query: { action: string; limit?: number; parameterCount: number },
  args: unknown[],
) {
  const last = args[args.length - 1];
  const pageable = args.length === query.parameterCount + 1 && isPageable(last)
    ? last
    : undefined;

  if (pageable) {
    if (query.action !== "find") {
      throw new NPAQueryError(`Query method "${methodName}" only supports Pageable on find queries.`, {
        code: "NPA_PAGEABLE_UNSUPPORTED_QUERY",
        details: { methodName, action: query.action },
      });
    }

    if (query.limit !== undefined) {
      throw new NPAQueryError(`Query method "${methodName}" cannot combine First/Top with Pageable.`, {
        code: "NPA_TOP_PAGEABLE_CONFLICT",
        details: { methodName },
      });
    }
  }

  const queryArgs = pageable ? args.slice(0, -1) : args;

  if (queryArgs.length !== query.parameterCount) {
    throw new NPAQueryError(
      `Query method "${methodName}" expects ${query.parameterCount} parameter(s), received ${args.length}.`,
      {
        code: "NPA_QUERY_ARGUMENT_COUNT_MISMATCH",
        details: {
          methodName,
          expected: query.parameterCount,
          received: args.length,
        },
      },
    );
  }

  return { queryArgs, pageable };
}
