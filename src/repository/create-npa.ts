import type { EntityTarget } from "../entity";
import {
  getRepositoryMetadata,
  getRepositoryTargetName,
  type NPARepositoryTarget,
} from "./repository-decorator";
import type { NPARepository } from "./types";

export interface NPACreateRepositoryOptions<
  TEntity extends object = object,
  TId = unknown,
  TRepository extends object = NPARepository<TEntity, TId>,
> {
  entity: EntityTarget<TEntity>;
  repository: NPARepositoryTarget<TRepository>;
}

export interface NPARuntimeAdapter {
  createRepository<
    TEntity extends object,
    TId = unknown,
    TRepository extends object = NPARepository<TEntity, TId>,
  >(
    options: NPACreateRepositoryOptions<TEntity, TId, TRepository>,
  ): TRepository & NPARepository<TEntity, TId>;
}

export interface CreateNPAOptions {
  adapter: NPARuntimeAdapter;
  repositories: ReadonlyArray<NPARepositoryTarget>;
}

export interface NPAApplication {
  get<TRepository extends object>(
    repository: NPARepositoryTarget<TRepository>,
  ): TRepository;
}

export function createNPA(options: CreateNPAOptions): NPAApplication {
  const repositories = new Map<NPARepositoryTarget, object>();

  for (const repository of options.repositories) {
    if (repositories.has(repository)) {
      throw new Error(
        `Repository ${getRepositoryTargetName(repository)} is registered more than once.`,
      );
    }

    const metadata = getRepositoryMetadata(repository);
    repositories.set(
      repository,
      options.adapter.createRepository({
        entity: metadata.entity,
        repository,
      }),
    );
  }

  return {
    get<TRepository extends object>(
      repository: NPARepositoryTarget<TRepository>,
    ): TRepository {
      const instance = repositories.get(repository);

      if (!instance) {
        throw new Error(
          `Repository ${getRepositoryTargetName(repository)} was not registered in createNPA().`,
        );
      }

      return instance as TRepository;
    },
  };
}
