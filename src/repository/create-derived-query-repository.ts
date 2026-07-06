import { NPAQueryError } from "../error";
import {
  assertNoDuplicateQueryPredicates,
  parseQueryMethod,
} from "../query-method";
import { getEntityGraphMetadata } from "./entity-graph-decorator";
import { getRawQueryMetadata } from "./query-decorator";
import { isPageable } from "./pagination";
import {
  RepositoryMethodInvocation,
  RepositoryMethodExecutor,
  RepositoryRawQueryInvocation,
  RepositoryRawQueryExecutor,
} from "./types";

export function createDerivedQueryRepository<TRepository extends object>(
  target: TRepository,
  executor: RepositoryMethodExecutor,
  rawExecutor?: RepositoryRawQueryExecutor,
): TRepository {
  return new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(currentTarget, property, receiver);
      }

      const rawQuery = getRawQueryMetadata(currentTarget, property);
      const entityGraph = getEntityGraphMetadata(currentTarget, property);

      if (rawQuery) {
        return (...args: unknown[]) => {
          if (!rawExecutor) {
            throw new NPAQueryError(
              `Repository method "${property}" uses @Query, but the adapter does not support raw queries.`,
              {
                code: "NPA_RAW_QUERY_RESULT_MODE_UNSUPPORTED",
                details: { methodName: property },
              },
            );
          }

          const invocation: RepositoryRawQueryInvocation = {
            query: rawQuery,
            methodName: property,
            args,
          };

          if (entityGraph) {
            invocation.entityGraph = entityGraph;
          }

          return rawExecutor(invocation);
        };
      }

      if (property in currentTarget) {
        return Reflect.get(currentTarget, property, receiver);
      }

      return (...args: unknown[]) => {
        const query = parseQueryMethod(property);
        assertNoDuplicateQueryPredicates(query);
        const { queryArgs, pageable } = splitQueryArgs(property, query, args);

        const invocation: RepositoryMethodInvocation = { query, args: queryArgs };

        if (entityGraph) {
          invocation.entityGraph = entityGraph;
        }

        if (pageable) {
          invocation.pageable = pageable;
        }

        return executor(invocation);
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
