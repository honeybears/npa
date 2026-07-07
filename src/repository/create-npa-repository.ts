import { NPAQueryError } from "../error";
import { createDerivedQueryRepository } from "./create-derived-query-repository";
import { getEntityGraphMetadata } from "./entity-graph-decorator";
import { createRelationMutations } from "./relation-mutation";
import {
  NPARepository,
  NPARepositoryAdapter,
  NPAFindOptions,
  NPALoadOptions,
} from "./types";

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
      findById: (id: TId) =>
        adapter.findById(
          id,
          toLoadOptions(getEntityGraphMetadata(target, "findById")),
        ),
      findAll: (options?: NPAFindOptions<TEntity>) =>
        adapter.findAll(
          mergeEntityGraphOptions(
            toLoadOptions(getEntityGraphMetadata(target, "findAll")),
            options,
          ),
        ),
      existsById: adapter.existsById,
      count: adapter.count,
      save: adapter.save,
      saveAll: (entities: Iterable<TEntity>) => saveAll(entities, adapter),
      relations: (entity: TEntity) => createRelationMutations(entity),
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
        throw new NPAQueryError(
          `Repository method "${invocation.methodName}" uses @Query, but the adapter does not support raw queries.`,
          {
            code: "NPA_RAW_QUERY_RESULT_MODE_UNSUPPORTED",
            details: { methodName: invocation.methodName },
          },
        );
      }

      return adapter.executeRawQuery(invocation);
    },
  ) as TRepository & NPARepository<TEntity, TId>;
}

async function saveAll<TEntity extends object>(
  entities: Iterable<TEntity>,
  adapter: Pick<NPARepositoryAdapter<TEntity>, "save">,
): Promise<TEntity[]> {
  const saved: TEntity[] = [];

  for (const entity of entities) {
    saved.push(await adapter.save(entity));
  }

  return saved;
}

function toLoadOptions<TEntity extends object>(
  entityGraph: ReturnType<typeof getEntityGraphMetadata> | undefined,
): NPALoadOptions<TEntity> | undefined {
  return entityGraph ? { relations: entityGraph.relations } : undefined;
}

function mergeEntityGraphOptions<TEntity extends object>(
  left: NPALoadOptions<TEntity> | undefined,
  right: NPAFindOptions<TEntity> | undefined,
): (NPAFindOptions<TEntity> & NPALoadOptions<TEntity>) | undefined {
  if (!left?.relations) {
    return right;
  }

  return { ...right, relations: left.relations };
}
