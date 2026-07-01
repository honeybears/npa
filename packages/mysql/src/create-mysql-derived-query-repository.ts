import { createNPARepository, NPARepository } from "@node-persistence-api/core";
import { MysqlRepositoryExecutor } from "./mysql-repository-executor";
import { MysqlRepositoryOptions } from "./types";

export function createMysqlDerivedQueryRepository<
  TRepository extends object,
  TEntity extends object = Record<string, unknown>,
  TId = unknown,
>(
  target: TRepository,
  options: MysqlRepositoryOptions,
): TRepository & NPARepository<TEntity, TId> {
  const executor = new MysqlRepositoryExecutor<TEntity, TId>(options);
  return createNPARepository(target, executor);
}
