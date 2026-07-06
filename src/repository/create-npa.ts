import type { EntityTarget } from "../entity";
import { NPAConfigurationError } from "../error";
import { registerTransactionManager } from "../transaction/transaction-manager-registry";
import type { TransactionManager } from "../transaction/types";
import type { NPAOperationsOptions } from "./operations";
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
  operations?: NPAOperationsOptions;
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
  operations?: NPAOperationsOptions;
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
      throw new NPAConfigurationError(
        [
          "No @Repository metadata has been loaded.",
          'Import repository modules before creating NPA, for example: import "./repositories";',
        ].join(" "),
        { code: "NPA_REPOSITORY_METADATA_REQUIRED" },
      );
    }

    for (const repository of repositoryTargets) {
      if (this.repositories.has(repository)) {
        throw new NPAConfigurationError(
          `Repository ${getRepositoryTargetName(repository)} is registered more than once.`,
          {
            code: "NPA_DUPLICATE_REPOSITORY",
            details: { repository: getRepositoryTargetName(repository) },
          },
        );
      }

      const metadata = getRepositoryMetadata(repository);
      this.repositories.set(
        repository,
        options.adapter.createRepository({
          entity: metadata.entity,
          operations: options.operations,
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
      throw new NPAConfigurationError(
        `Repository ${getRepositoryTargetName(repository)} was not registered in this NPA instance.`,
        {
          code: "NPA_REPOSITORY_METADATA_REQUIRED",
          details: { repository: getRepositoryTargetName(repository) },
        },
      );
    }

    return instance as TRepository;
  }
}

export function createNPA(options: CreateNPAOptions): NPAApplication {
  return new NPA(options);
}
