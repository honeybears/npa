import { ParsedQueryMethod } from "../query-method";
import type { NPAEntityGraphMetadata } from "./entity-graph-decorator";
import type {
  CursorPage,
  OffsetPageable,
  CursorPageable,
  PageRequest,
  Page,
} from "./pagination";
import type { NPARawQueryMetadata } from "./query-decorator";
import type { NPARelationLoad } from "./relation-load-types";

export type {
  Loaded,
  NPARelationLoad,
  NPARelationLoadTree,
} from "./relation-load-types";
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
  select?: readonly string[];
  entityGraph?: NPAEntityGraphMetadata;
}

export interface RepositoryMethodExecutor<TResult = unknown> {
  (invocation: RepositoryMethodInvocation): TResult;
}

export interface RepositoryRawQueryInvocation {
  query: NPARawQueryMetadata;
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

export type NPASelect<TEntity extends object = object> = readonly (keyof TEntity & string)[];

export type NPAProjection<
  TEntity extends object,
  TSelect extends NPASelect<TEntity>,
> = Pick<TEntity, TSelect[number]>;

export interface NPABaseFindOptions<TEntity extends object = object>
  extends NPALoadOptions<TEntity> {
  pageable?: PageRequest;
  orderBy?: readonly NPAOrderBy<TEntity>[];
  select?: never;
}

export interface NPAProjectionFindOptions<
  TEntity extends object = object,
  TSelect extends NPASelect<TEntity> = NPASelect<TEntity>,
> {
  pageable?: PageRequest;
  orderBy?: readonly NPAOrderBy<TEntity>[];
  select: TSelect;
  relations?: never;
}

export type NPAFindOptions<TEntity extends object = object> =
  | NPABaseFindOptions<TEntity>
  | NPAProjectionFindOptions<TEntity>;

export abstract class NPARepository<TEntity extends object, TId = unknown> {
  abstract findById(
    id: TId,
    options?: NPALoadOptions<TEntity>,
  ): Promise<TEntity | null>;
  abstract findAll<TSelect extends NPASelect<TEntity>>(
    options: NPAProjectionFindOptions<TEntity, TSelect> & { pageable: OffsetPageable },
  ): Promise<Page<NPAProjection<TEntity, TSelect>>>;
  abstract findAll<TSelect extends NPASelect<TEntity>>(
    options: NPAProjectionFindOptions<TEntity, TSelect> & { pageable: CursorPageable },
  ): Promise<CursorPage<NPAProjection<TEntity, TSelect>>>;
  abstract findAll<TSelect extends NPASelect<TEntity>>(
    options: NPAProjectionFindOptions<TEntity, TSelect>,
  ): Promise<Array<NPAProjection<TEntity, TSelect>>>;
  abstract findAll(
    options: NPABaseFindOptions<TEntity> & { pageable: OffsetPageable },
  ): Promise<Page<TEntity>>;
  abstract findAll(
    options: NPABaseFindOptions<TEntity> & { pageable: CursorPageable },
  ): Promise<CursorPage<TEntity>>;
  abstract findAll(options?: NPABaseFindOptions<TEntity>): Promise<TEntity[]>;
  abstract existsById(id: TId): Promise<boolean>;
  abstract count(): Promise<number>;
  abstract persist(entity: TEntity): Promise<TEntity>;
  abstract save(entity: TEntity): Promise<TEntity | null>;
  abstract insert(entity: TEntity): Promise<TEntity>;
  abstract update(entity: TEntity): Promise<TEntity | null>;
  abstract updateById(
    id: TId,
    patch: Partial<TEntity>,
  ): Promise<TEntity | null>;
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
    options?: NPAFindOptions<TEntity>,
  ): Promise<TEntity[] | Page<TEntity> | CursorPage<TEntity>>;
  existsById(id: TId): Promise<boolean>;
  count(): Promise<number>;
  persist(entity: TEntity): Promise<TEntity>;
  save(entity: TEntity): Promise<TEntity | null>;
  insert(entity: TEntity): Promise<TEntity>;
  update(entity: TEntity): Promise<TEntity | null>;
  updateById(
    id: TId,
    patch: Partial<TEntity>,
  ): Promise<TEntity | null>;
  remove(entity: TEntity): Promise<void>;
  delete(entityOrId: TEntity | TId): Promise<number>;
  deleteById(id: TId): Promise<number>;
  deleteAll(): Promise<number>;
  executeDerivedQuery(invocation: RepositoryMethodInvocation): Promise<unknown>;
  executeRawQuery?(invocation: RepositoryRawQueryInvocation): Promise<unknown>;
}
