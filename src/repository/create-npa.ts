import type { EntityTarget } from "../entity";
import {
  getRegisteredRepositoryTargets,
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

export interface NPAOptions {
  adapter: NPARuntimeAdapter;
  repositories?: NPARepositoryTarget[];
}

export type CreateNPAOptions = NPAOptions;

export interface NPAApplication {
  get<TRepository extends object>(
    repository: NPARepositoryTarget<TRepository>,
  ): TRepository;
}

export class NPA implements NPAApplication {
  private readonly repositories = new Map<NPARepositoryTarget, object>();

  constructor(options: NPAOptions) {
    const repositoryTargets =
      options.repositories ?? getRegisteredRepositoryTargets();

    for (const repository of repositoryTargets) {
      if (this.repositories.has(repository)) {
        throw new Error(
          `Repository ${getRepositoryTargetName(repository)} is registered more than once.`,
        );
      }

      const metadata = getRepositoryMetadata(repository);
      this.repositories.set(
        repository,
        options.adapter.createRepository({
          entity: metadata.entity,
          repository,
        }),
      );
    }
  }

  get<TRepository extends object>(
    repository: NPARepositoryTarget<TRepository>,
  ): TRepository {
    const instance = this.repositories.get(repository);

    if (!instance) {
      throw new Error(
        `Repository ${getRepositoryTargetName(repository)} was not registered in this NPA instance.`,
      );
    }

    return instance as TRepository;
  }
}

export function createNPA(options: CreateNPAOptions): NPAApplication {
  return new NPA(options);
}
