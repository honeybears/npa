import { createNPARepository } from "@node-persistence-api/core";
import type {
  NPACreateRepositoryOptions,
  NPARepository,
  NPARuntimeAdapter,
} from "@node-persistence-api/core";
import { toPostgresqlDatabaseError } from "./postgresql-database-error";
import { PostgresqlRepositoryExecutor } from "./postgresql-repository-executor";
import { PostgresqlQueryable, PostgresqlQueryResult } from "./types";
import {
  PostgresqlTransactionConnection,
  PostgresqlTransactionManager,
} from "./postgresql-transaction-manager";

export type PostgresqlAdapterOptions =
  | { connection: PostgresqlTransactionConnection; queryable?: never }
  | { connection?: never; queryable: PostgresqlQueryable };

export function postgresql(
  options: PostgresqlAdapterOptions,
): NPARuntimeAdapter {
  const transactionManager = options.connection
    ? new PostgresqlTransactionManager(options.connection)
    : undefined;
  const queryable = wrapPostgresqlQueryable(
    transactionManager?.queryable ?? options.queryable,
  );

  if (!queryable) {
    throw new Error("PostgreSQL adapter requires queryable or connection.");
  }

  return {
    transactionManager,

    createRepository<
      TEntity extends object,
      TId = unknown,
      TRepository extends object = NPARepository<TEntity, TId>,
    >(
      repositoryOptions: NPACreateRepositoryOptions<
        TEntity,
        TId,
        TRepository
      >,
    ): TRepository & NPARepository<TEntity, TId> {
      const executor = new PostgresqlRepositoryExecutor<TEntity, TId>({
        entity: repositoryOptions.entity,
        operations: repositoryOptions.operations,
        queryable,
      });
      const target = Object.create(
        repositoryOptions.repository.prototype,
      ) as TRepository;

      return createNPARepository(target, executor);
    },
  };
}

function wrapPostgresqlQueryable(
  queryable: PostgresqlQueryable | undefined,
): PostgresqlQueryable | undefined {
  if (!queryable) {
    return undefined;
  }

  return {
    query: async <TRow = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<PostgresqlQueryResult<TRow>> => {
      try {
        return await queryable.query<TRow>(text, values);
      } catch (error) {
        throw toPostgresqlDatabaseError(error);
      }
    },
  };
}
