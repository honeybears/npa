import { createNPARepository, NPAConfigurationError } from "@node-persistence-api/core";
import type {
  NPACreateRepositoryOptions,
  NPARepository,
  NPARuntimeAdapter,
} from "@node-persistence-api/core";
import { MysqlRepositoryExecutor } from "./mysql-repository-executor";
import { MysqlQueryable } from "./types";
import {
  MysqlTransactionConnection,
  MysqlTransactionManager,
} from "./mysql-transaction-manager";

export type MysqlAdapterOptions =
  | {
      connection: MysqlTransactionConnection;
      preferExecute?: boolean;
      queryable?: never;
    }
  | {
      connection?: never;
      preferExecute?: boolean;
      queryable: MysqlQueryable;
    };

export function mysql(options: MysqlAdapterOptions): NPARuntimeAdapter {
  const transactionManager = options.connection
    ? new MysqlTransactionManager(options.connection)
    : undefined;
  const queryable = transactionManager?.queryable ?? options.queryable;

  if (!queryable) {
    throw new NPAConfigurationError("MySQL adapter requires queryable or connection.", {
      code: "NPA_ADAPTER_REQUIRED",
    });
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
