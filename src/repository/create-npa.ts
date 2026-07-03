import type { EntityTarget } from "../entity";
import { registerTransactionManager } from "../transaction/transaction-manager-registry";
import type { TransactionManager } from "../transaction/types";
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
  transactionManager?: TransactionManager;

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
  name?: string;
  repositories?: NPARepositoryTarget[];
  transactionManager?: TransactionManager;
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

    if (!options.repositories && repositoryTargets.length === 0) {
      throw new Error(
        [
          "No @Repository metadata has been loaded.",
          'Import repository modules before creating NPA, for example: import "./repositories";',
        ].join(" "),
      );
    }

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

    const transactionManager =
      options.transactionManager ?? options.adapter.transactionManager;

    if (transactionManager) {
      registerTransactionManager(transactionManager, options.name);
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
