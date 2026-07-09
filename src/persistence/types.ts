import { ColumnMetadata, EntityTarget, RelationMetadata } from "../entity";

export interface NPADirtyCheckUpdateOptions {
  expectedVersion?: unknown;
  versionColumn?: ColumnMetadata;
}

export interface NPADirtyCheckAdapter<TEntity extends object = object> {
  updateDirty(
    entity: TEntity,
    id: unknown,
    patch: Partial<TEntity>,
    options?: NPADirtyCheckUpdateOptions,
  ): Promise<TEntity | null> | TEntity | null;
  insertManaged?(
    entity: TEntity,
  ): Promise<TEntity> | TEntity;
  deleteManaged?(
    entity: TEntity,
    id: unknown,
  ): Promise<number> | number;
  syncManyToManyRelations?(
    entity: TEntity,
    id: unknown,
    relation: RelationMetadata,
    targetIds: unknown[],
  ): Promise<void> | void;
  deleteManyToManyRelations?(
    entity: TEntity,
    id: unknown,
    relation: RelationMetadata,
  ): Promise<void> | void;
  forEntity?(entity: EntityTarget): NPADirtyCheckAdapter;
}

export interface NPAManageEntityOptions<TEntity extends object = object> {
  adapter: NPADirtyCheckAdapter<TEntity>;
  entity: EntityTarget<TEntity>;
}
