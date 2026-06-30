import { ColumnMetadata, EntityTarget } from "../entity";

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
}

export interface NPAManageEntityOptions<TEntity extends object = object> {
  adapter: NPADirtyCheckAdapter<TEntity>;
  entity: EntityTarget<TEntity>;
}
