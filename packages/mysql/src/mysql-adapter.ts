import { createNPARepository } from "@node-persistence-api/core";
import type {
  NPACreateRepositoryOptions,
  NPARepository,
  NPARuntimeAdapter,
} from "@node-persistence-api/core";
import { MysqlRepositoryExecutor } from "./mysql-repository-executor";
import { MysqlQueryable } from "./types";

export interface MysqlAdapterOptions {
  preferExecute?: boolean;
  queryable: MysqlQueryable;
}

export function mysql(options: MysqlAdapterOptions): NPARuntimeAdapter {
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
      const executor = new MysqlRepositoryExecutor<TEntity, TId>({
        entity: repositoryOptions.entity,
        preferExecute: options.preferExecute,
        queryable: options.queryable,
      });
      const target = Object.create(
        repositoryOptions.repository.prototype,
      ) as TRepository;

      return createNPARepository(target, executor);
    },
  };
}
