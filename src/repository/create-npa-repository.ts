import { createDerivedQueryRepository } from "./create-derived-query-repository";
import { NPARepository, NPARepositoryAdapter } from "./types";

export function createNPARepository<
  TRepository extends object,
  TEntity extends object,
  TId = unknown,
>(
  target: TRepository,
  adapter: NPARepositoryAdapter<TEntity, TId>,
): TRepository & NPARepository<TEntity, TId> {
  const repository = Object.assign(
    Object.create(Object.getPrototypeOf(target) ?? Object.prototype),
    {
      findById: adapter.findById,
      findAll: adapter.findAll,
      existsById: adapter.existsById,
      count: adapter.count,
      save: adapter.save,
      insert: adapter.insert,
      update: adapter.update,
      updateById: adapter.updateById,
      delete: adapter.delete,
      deleteById: adapter.deleteById,
      deleteAll: adapter.deleteAll,
    },
    target,
  );

  return createDerivedQueryRepository(
    repository,
    (invocation) => adapter.executeDerivedQuery(invocation),
    (invocation) => {
      if (!adapter.executeRawQuery) {
        throw new Error(
          `Repository method "${invocation.methodName}" uses @Query, but the adapter does not support raw queries.`,
        );
      }

      return adapter.executeRawQuery(invocation);
    },
  ) as TRepository & NPARepository<TEntity, TId>;
}
