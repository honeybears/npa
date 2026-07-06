import { ParsedQueryMethod } from "../query-method";
import type { NPAEntityGraphMetadata } from "./entity-graph-decorator";
import type {
  CursorPage,
  OffsetPageable,
  CursorPageable,
  PageRequest,
  Page,
} from "./pagination";
import type { RawQueryMetadata } from "./query-decorator";
import type { NPARelationLoad } from "./relation-load-types";
import type { NPARelationMutations } from "./relation-mutation";

export type {
  Loaded,
  NPARelationLoad,
  NPARelationLoadTree,
} from "./relation-load-types";
export type {
  NPARelationCollection,
  NPARelationMutations,
  NPAToManyRelationItem,
  NPAToManyRelationKeys,
} from "./relation-mutation";
export type {
  CursorPage,
  CursorQueryMetadata,
  OffsetPageable,
  CursorPageable,
  PageRequest,
  Page,
} from "./pagination";
export { Pageable } from "./pagination";

export interface RepositoryMethodInvocation {
  query: ParsedQueryMethod;
  args: unknown[];
  pageable?: PageRequest;
  entityGraph?: NPAEntityGraphMetadata;
}

export interface RepositoryMethodExecutor<TResult = unknown> {
  (invocation: RepositoryMethodInvocation): TResult;
}

export interface RepositoryRawQueryInvocation {
  query: RawQueryMetadata;
  methodName: string;
  args: unknown[];
  entityGraph?: NPAEntityGraphMetadata;
}

export interface RepositoryRawQueryExecutor<TResult = unknown> {
  (invocation: RepositoryRawQueryInvocation): TResult;
}

export interface NPALoadOptions<TEntity extends object = object> {
  relations?: NPARelationLoad<TEntity>;
}

export type NPAOrderDirection = "asc" | "desc";

export interface NPAOrderBy<TEntity extends object = object> {
  property: keyof TEntity & string;
  direction?: NPAOrderDirection;
}

export interface NPABaseFindOptions<TEntity extends object = object> {
  pageable?: PageRequest;
  orderBy?: readonly NPAOrderBy<TEntity>[];
}

export type NPAFindOptions<TEntity extends object = object> =
  NPABaseFindOptions<TEntity>;

export abstract class NPARepository<TEntity extends object, TId = unknown> {
  abstract findById(
    id: TId,
  ): Promise<TEntity | null>;
  abstract findAll(
    options: NPABaseFindOptions<TEntity> & { pageable: OffsetPageable },
  ): Promise<Page<TEntity>>;
  abstract findAll(
    options: NPABaseFindOptions<TEntity> & { pageable: CursorPageable },
  ): Promise<CursorPage<TEntity>>;
  abstract findAll(options?: NPABaseFindOptions<TEntity>): Promise<TEntity[]>;
  abstract existsById(id: TId): Promise<boolean>;
  abstract count(): Promise<number>;
  abstract save(entity: TEntity): Promise<TEntity | null>;
  abstract saveAll(entities: Iterable<TEntity>): Promise<Array<TEntity | null>>;
  abstract relations(entity: TEntity): NPARelationMutations<TEntity>;
  abstract remove(entity: TEntity): Promise<void>;
  abstract delete(entityOrId: TEntity | TId): Promise<number>;
  abstract deleteById(id: TId): Promise<number>;
  abstract deleteAll(): Promise<number>;
}

export interface NPARepositoryAdapter<TEntity extends object, TId = unknown> {
  findById(
    id: TId,
    options?: NPALoadOptions<TEntity>,
  ): Promise<TEntity | null>;
  findAll(
    options?: NPAFindOptions<TEntity> & NPALoadOptions<TEntity>,
  ): Promise<TEntity[] | Page<TEntity> | CursorPage<TEntity>>;
  existsById(id: TId): Promise<boolean>;
  count(): Promise<number>;
  save(entity: TEntity): Promise<TEntity | null>;
  remove(entity: TEntity): Promise<void>;
  delete(entityOrId: TEntity | TId): Promise<number>;
  deleteById(id: TId): Promise<number>;
  deleteAll(): Promise<number>;
  executeDerivedQuery(invocation: RepositoryMethodInvocation): Promise<unknown>;
  executeRawQuery?(invocation: RepositoryRawQueryInvocation): Promise<unknown>;
}
