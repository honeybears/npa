import type { EntityTarget } from "../entity";
import { NPAConfigurationError } from "../error";
import { registerTransactionManager } from "../transaction/transaction-manager-registry";
import type { TransactionManager } from "../transaction/types";
import type { NPAOperationsOptions } from "./operations";
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

class NPA implements NPAApplication {
  private readonly repositories = new Map<NPARepositoryTarget, object>();
  private readonly allowedRepositories?: Set<NPARepositoryTarget>;
  private readonly adapter: NPARuntimeAdapter;
  private readonly operations?: NPAOperationsOptions;

  constructor(options: NPAOptions) {
    this.adapter = options.adapter;
    this.operations = options.operations;

    if (options.repositories) {
      this.allowedRepositories = new Set();

      for (const repository of options.repositories) {
        if (this.allowedRepositories.has(repository)) {
          throw new NPAConfigurationError(
            `Repository ${getRepositoryTargetName(repository)} is registered more than once.`,
            {
              code: "NPA_DUPLICATE_REPOSITORY",
              details: { repository: getRepositoryTargetName(repository) },
            },
          );
        }

        getRepositoryMetadata(repository);
        this.allowedRepositories.add(repository);
      }
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

    if (instance) {
      return instance as TRepository;
    }

    if (
      this.allowedRepositories &&
      !this.allowedRepositories.has(repository)
    ) {
      throw new NPAConfigurationError(
        `Repository ${getRepositoryTargetName(repository)} was not registered in this NPA instance.`,
        {
          code: "NPA_REPOSITORY_METADATA_REQUIRED",
          details: { repository: getRepositoryTargetName(repository) },
        },
      );
    }

    const metadata = getRepositoryMetadata(repository);
    const created = this.adapter.createRepository({
      entity: metadata.entity,
      operations: this.operations,
      repository,
    });
    this.repositories.set(repository, created);
    return created as TRepository;
  }
}

export function createNPA(options: CreateNPAOptions): NPAApplication {
  return new NPA(options);
}
