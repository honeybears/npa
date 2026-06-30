import { createNPARepository } from "@honeybeaers/npa";
import type {
  NPACreateRepositoryOptions,
  NPARepository,
  NPARuntimeAdapter,
} from "@honeybeaers/npa";
import { PostgresqlRepositoryExecutor } from "./postgresql-repository-executor";
import { PostgresqlQueryable } from "./types";

export interface PostgresqlAdapterOptions {
  queryable: PostgresqlQueryable;
}

export function postgresql(
  options: PostgresqlAdapterOptions,
): NPARuntimeAdapter {
  return {
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
        queryable: options.queryable,
      });
      const target = Object.create(
        repositoryOptions.repository.prototype,
      ) as TRepository;

      return createNPARepository(target, executor);
    },
  };
}
