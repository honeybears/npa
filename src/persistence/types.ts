import { EntityTarget } from "../entity";

export interface NPADirtyCheckAdapter<TEntity extends object = object> {
  updateDirty(
    entity: TEntity,
    id: unknown,
    patch: Partial<TEntity>,
  ): Promise<TEntity | null> | TEntity | null;
}

export interface NPAManageEntityOptions<TEntity extends object = object> {
  adapter: NPADirtyCheckAdapter<TEntity>;
  entity: EntityTarget<TEntity>;
}
