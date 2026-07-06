import type { EntityTarget } from "../entity";
import { NPAConfigurationError } from "../error";

export type NPARepositoryTarget<TRepository extends object = object> =
  (abstract new (...args: any[]) => TRepository) & {
    readonly name?: string;
    readonly prototype: TRepository;
  };

export interface NPARepositoryMetadata<TEntity extends object = object> {
  entity: EntityTarget<TEntity>;
  repository: NPARepositoryTarget;
}

const repositoryMetadata = new WeakMap<object, NPARepositoryMetadata>();
const registeredRepositories = new Set<NPARepositoryTarget>();

export function Repository<TEntity extends object>(
  entity: EntityTarget<TEntity>,
): ClassDecorator {
  return (target) => {
    const repository = target as unknown as NPARepositoryTarget;

    repositoryMetadata.set(repository, {
      entity,
      repository,
    });
    registeredRepositories.add(repository);
  };
}

export function getRegisteredRepositoryTargets(): NPARepositoryTarget[] {
  return Array.from(registeredRepositories);
}

export function getRepositoryMetadata<
  TEntity extends object = object,
  TRepository extends object = object,
>(
  repository: NPARepositoryTarget<TRepository>,
): NPARepositoryMetadata<TEntity> {
  const metadata = repositoryMetadata.get(repository);

  if (!metadata) {
    throw new NPAConfigurationError(
      `Repository ${getRepositoryTargetName(repository)} is missing @Repository(Entity).`,
      {
        code: "NPA_REPOSITORY_METADATA_REQUIRED",
        details: { repository: getRepositoryTargetName(repository) },
      },
    );
  }

  return metadata as NPARepositoryMetadata<TEntity>;
}

export function getRepositoryTargetName(
  repository: NPARepositoryTarget,
): string {
  return repository.name || "<anonymous repository>";
}
