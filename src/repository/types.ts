import { ParsedQueryMethod } from "../query-method";

export interface RepositoryMethodInvocation {
  query: ParsedQueryMethod;
  args: unknown[];
}

export interface RepositoryMethodExecutor<TResult = unknown> {
  (invocation: RepositoryMethodInvocation): TResult;
}

export interface NPALoadOptions<TEntity extends object = object> {
  relations?: true | Array<Extract<keyof TEntity, string> | string>;
}

export interface NPARepository<TEntity extends object, TId = unknown> {
  findById(id: TId, options?: NPALoadOptions<TEntity>): Promise<TEntity | null>;
  findAll(options?: NPALoadOptions<TEntity>): Promise<TEntity[]>;
  existsById(id: TId): Promise<boolean>;
  count(): Promise<number>;
  save(entity: TEntity): Promise<TEntity | null>;
  insert(entity: TEntity): Promise<TEntity>;
  update(entity: TEntity): Promise<TEntity | null>;
  updateById(id: TId, patch: Partial<TEntity>): Promise<TEntity | null>;
  delete(entityOrId: TEntity | TId): Promise<number>;
  deleteById(id: TId): Promise<number>;
  deleteAll(): Promise<number>;
}

export interface NPARepositoryAdapter<TEntity extends object, TId = unknown>
  extends NPARepository<TEntity, TId> {
  executeDerivedQuery(invocation: RepositoryMethodInvocation): Promise<unknown>;
}
