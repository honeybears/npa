import { createNPARepository, NPAConfigurationError } from "@node-persistence-api/core/adapter";
import type {
  NPACreateRepositoryOptions,
  NPARepository,
  NPARuntimeAdapter,
} from "@node-persistence-api/core/adapter";
import { PostgresqlRepositoryExecutor } from "./postgresql-repository-executor";
import {
  PostgresqlTransactionConnection,
  PostgresqlTransactionManager,
} from "./postgresql-transaction-manager";

export interface PostgresqlAdapterOptions {
  connection: PostgresqlTransactionConnection;
}

export function postgresql(
  options: PostgresqlAdapterOptions,
): NPARuntimeAdapter {
  if (!options.connection) {
    throw new NPAConfigurationError("PostgreSQL adapter requires connection.", {
      code: "NPA_ADAPTER_REQUIRED",
    });
  }

  const transactionManager = new PostgresqlTransactionManager(options.connection);
  const queryable = transactionManager.queryable;

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
