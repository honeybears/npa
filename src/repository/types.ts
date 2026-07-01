import { ParsedQueryMethod } from "../query-method";
import type { NPARawQueryMetadata } from "./query-decorator";

export interface RepositoryMethodInvocation {
  query: ParsedQueryMethod;
  args: unknown[];
}

export interface RepositoryMethodExecutor<TResult = unknown> {
  (invocation: RepositoryMethodInvocation): TResult;
}

export interface RepositoryRawQueryInvocation {
  query: NPARawQueryMetadata;
  methodName: string;
  args: unknown[];
}

export interface RepositoryRawQueryExecutor<TResult = unknown> {
  (invocation: RepositoryRawQueryInvocation): TResult;
}

export interface NPALoadOptions<TEntity extends object = object> {
  relations?: true | Array<Extract<keyof TEntity, string> | string>;
}

export abstract class NPARepository<TEntity extends object, TId = unknown> {
  abstract findById(
    id: TId,
    options?: NPALoadOptions<TEntity>,
  ): Promise<TEntity | null>;
  abstract findAll(options?: NPALoadOptions<TEntity>): Promise<TEntity[]>;
  abstract existsById(id: TId): Promise<boolean>;
  abstract count(): Promise<number>;
  abstract save(entity: TEntity): Promise<TEntity | null>;
  abstract insert(entity: TEntity): Promise<TEntity>;
  abstract update(entity: TEntity): Promise<TEntity | null>;
  abstract updateById(
    id: TId,
    patch: Partial<TEntity>,
  ): Promise<TEntity | null>;
  abstract delete(entityOrId: TEntity | TId): Promise<number>;
  abstract deleteById(id: TId): Promise<number>;
  abstract deleteAll(): Promise<number>;
}

export interface NPARepositoryAdapter<TEntity extends object, TId = unknown>
  extends NPARepository<TEntity, TId> {
  executeDerivedQuery(invocation: RepositoryMethodInvocation): Promise<unknown>;
  executeRawQuery?(invocation: RepositoryRawQueryInvocation): Promise<unknown>;
}
