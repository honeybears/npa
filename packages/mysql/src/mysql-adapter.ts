import { createNPARepository, NPAConfigurationError } from "@node-persistence-api/core/adapter";
import type {
  NPACreateRepositoryOptions,
  NPARepository,
  NPARuntimeAdapter,
} from "@node-persistence-api/core/adapter";
import { MysqlRepositoryExecutor } from "./mysql-repository-executor";
import {
  MysqlTransactionConnection,
  MysqlTransactionManager,
} from "./mysql-transaction-manager";

export interface MysqlAdapterOptions {
  connection: MysqlTransactionConnection;
  preferExecute?: boolean;
}

export function mysql(options: MysqlAdapterOptions): NPARuntimeAdapter {
  if (!options.connection) {
    throw new NPAConfigurationError("MySQL adapter requires connection.", {
      code: "NPA_ADAPTER_REQUIRED",
    });
  }

  const transactionManager = new MysqlTransactionManager(options.connection);
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
      const executor = new MysqlRepositoryExecutor<TEntity, TId>({
        entity: repositoryOptions.entity,
        operations: repositoryOptions.operations,
        preferExecute: options.preferExecute,
        queryable,
      });
      const target = Object.create(
        repositoryOptions.repository.prototype,
      ) as TRepository;

      return createNPARepository(target, executor);
    },
  };
}
