import { createNPARepository, NPAConfigurationError } from "@node-persistence-api/core/adapter";
import type {
  NPACreateRepositoryOptions,
  NPARepository,
  NPARuntimeAdapter,
} from "@node-persistence-api/core/adapter";
import { toPostgresqlDatabaseError } from "./postgresql-database-error";
import { PostgresqlRepositoryExecutor } from "./postgresql-repository-executor";
import { PostgresqlQueryable, PostgresqlQueryResult } from "./types";
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
  const queryable = wrapPostgresqlQueryable(transactionManager.queryable);

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
  queryable: PostgresqlQueryable,
): PostgresqlQueryable {
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
