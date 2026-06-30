import type { EntityTarget } from "../entity";

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

export function Repository<TEntity extends object>(
  entity: EntityTarget<TEntity>,
): ClassDecorator {
  return (target) => {
    const repository = target as unknown as NPARepositoryTarget;

    repositoryMetadata.set(repository, {
      entity,
      repository,
    });
  };
}

export function getRepositoryMetadata<
  TEntity extends object = object,
  TRepository extends object = object,
>(
  repository: NPARepositoryTarget<TRepository>,
): NPARepositoryMetadata<TEntity> {
  const metadata = repositoryMetadata.get(repository);

  if (!metadata) {
    throw new Error(
      `Repository ${getRepositoryTargetName(repository)} is missing @Repository(Entity).`,
    );
  }

  return metadata as NPARepositoryMetadata<TEntity>;
}

export function getRepositoryTargetName(
  repository: NPARepositoryTarget,
): string {
  return repository.name || "<anonymous repository>";
}
