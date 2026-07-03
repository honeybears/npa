import { createNPARepository } from "@node-persistence-api/core";
import type {
  NPACreateRepositoryOptions,
  NPARepository,
  NPARuntimeAdapter,
} from "@node-persistence-api/core";
import { PostgresqlRepositoryExecutor } from "./postgresql-repository-executor";
import { PostgresqlQueryable } from "./types";
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
  const queryable = transactionManager?.queryable ?? options.queryable;

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
        queryable,
      });
      const target = Object.create(
        repositoryOptions.repository.prototype,
      ) as TRepository;

      return createNPARepository(target, executor);
    },
  };
}
