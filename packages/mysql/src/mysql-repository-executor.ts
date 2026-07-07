import {
  compileTupleWhere,
  createCursorWindow,
  createPage,
  defaultQualifiedJoinTableName,
  EntityMetadata,
  findAllInvocation,
  firstColumn,
  getCurrentPersistenceContext,
  getEntityMetadata,
  idParts,
  type EntityTarget,
  isCursorPageable,
  isOffsetPageable,
  needsOrmDelete,
  primaryColumnsOf,
  CursorPage,
  NPAFindOptions,
  NPAPaginationError,
  NPAQueryError,
  NPARepositoryAdapter,
  NPADirtyCheckAdapter,
  NPALoadOptions,
  Page,
  PersistenceContext,
  RelationMetadata,
  readExpectedVersionFromPatch,
  removeCascadeRelationTree,
  RepositoryMethodExecutor,
  RepositoryMethodInvocation,
  RepositoryRawQueryExecutor,
  requireAdapterMetadata,
  resolveManyToManyJoin,
  stripCursorKeys,
  toEntityGraphLoad,
  withEagerRelations,
  withUpdatedAtTimestamp,
} from "@node-persistence-api/core";
import {
  compileMysqlCount,
  compileMysqlDeleteAll,
  compileMysqlDeleteById,
  compileMysqlExistsById,
  compileMysqlFindAll,
  compileMysqlFindById,
  compileMysqlInsert,
  compileMysqlUpdate,
  compileMysqlVersionedUpdate,
  getMysqlPrimaryKeyValue,
} from "./mysql-crud-compiler";
import {
  quoteMysqlIdentifier,
  quoteMysqlQualifiedIdentifier,
} from "./mysql-identifiers";
import { compileMysqlQuery } from "./mysql-query-compiler";
import { compileMysqlRawQuery } from "./mysql-raw-query";
import { instrumentMysqlQueryable } from "./mysql-operations";
import {
  attachMysqlLazyRelations,
  loadMysqlRelations,
} from "./mysql-relation-loader";
import { executeMysqlQuery } from "./mysql-result";
import { MysqlRepositoryOptions } from "./types";

export class MysqlRepositoryExecutor<TEntity extends object, TId = unknown>
  implements NPARepositoryAdapter<TEntity, TId>
{
  private readonly dirtyCheckAdapter: NPADirtyCheckAdapter<TEntity>;
  private readonly options: MysqlRepositoryOptions;

  constructor(options: MysqlRepositoryOptions) {
    this.options = {
      ...options,
      queryable: instrumentMysqlQueryable(
        options.queryable,
        options.operations,
      ),
    };
    this.dirtyCheckAdapter = this.createDirtyCheckAdapter(
      this.options.entity as EntityTarget<TEntity> | undefined,
    );
  }

  executeDerivedQuery: RepositoryMethodExecutor<Promise<unknown>> = async (
    invocation,
  ) => {
    if (invocation.query.action === "delete" && this.shouldUseOrmDelete()) {
      return this.executeOrmDerivedDelete(invocation);
    }

    if (invocation.pageable && invocation.query.action !== "find") {
      throw new NPAQueryError(`Query method "${invocation.query.methodName}" only supports Pageable on find queries.`, {
        code: "NPA_PAGEABLE_UNSUPPORTED_QUERY",
        details: { methodName: invocation.query.methodName },
      });
    }

    if (invocation.pageable) {
      return this.executePageQuery(
        invocation,
        toEntityGraphLoad(invocation.entityGraph),
      );
    }

    const query = compileMysqlQuery(invocation, this.options);
    const result = await executeMysqlQuery(
      this.options,
      query.text,
      query.values,
    );

    switch (invocation.query.action) {
      case "find": {
        const rows = await this.loadRelations(
          result.rows as TEntity[],
          toEntityGraphLoad(invocation.entityGraph),
        );
        return this.manageMany(this.attachLazy(rows));
      }
      case "findOne": {
        const rows = await this.loadRelations(
          result.rows.slice(0, 1) as TEntity[],
          toEntityGraphLoad(invocation.entityGraph),
        );
        return this.manage(this.attachLazy(rows)[0] ?? null);
      }
      case "exists":
        return Boolean(result.rows[0]?.exists);
      case "count":
        return Number(result.rows[0]?.count ?? 0);
      case "delete": {
        const deletedCount = result.affectedRows ?? 0;

        if (deletedCount > 0) {
          this.detachAll();
        }

        return deletedCount;
      }
    }
  };

  executeRawQuery: RepositoryRawQueryExecutor<Promise<unknown>> = async (
    invocation,
  ) => {
    const query = compileMysqlRawQuery(
      invocation.query.text,
      invocation.args,
      invocation.methodName,
    );
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );

    const rows = await this.loadRelations(
      result.rows as TEntity[],
      toEntityGraphLoad(invocation.entityGraph),
    );

    return this.formatRawQueryResult(
      invocation.query,
      rows,
      result.affectedRows ?? 0,
    );
  };

  findById = async (id: TId, load?: NPALoadOptions<TEntity>): Promise<TEntity | null> => {
    const managed = this.findManagedById(id);

    if (managed) {
      const loaded = await this.loadRelations(this.attachLazy([managed]), load);
      return this.manage(loaded[0] ?? null);
    }

    const row = await this.findByIdRow(id);
    const loaded = await this.loadRelations(row ? [row] : [], load);

    return this.manage(this.attachLazy(loaded)[0] ?? null);
  };

  findAll = async (
    load?: NPAFindOptions<TEntity> & NPALoadOptions<TEntity>,
  ): Promise<TEntity[] | Page<TEntity> | CursorPage<TEntity>> => {
    if (load?.pageable) {
      return this.executePageQuery(
        findAllInvocation(load),
        load,
      );
    }

    if (load?.orderBy?.length) {
      const invocation = findAllInvocation(load);
      const query = compileMysqlQuery(invocation, this.options);
      const result = await executeMysqlQuery<TEntity>(
        this.options,
        query.text,
        query.values,
      );

      return this.manageMany(this.attachLazy(await this.loadRelations(result.rows, load)));
    }

    const query = compileMysqlFindAll(this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );

    return this.manageMany(this.attachLazy(await this.loadRelations(result.rows, load)));
  };

  existsById = async (id: TId): Promise<boolean> => {
    const query = compileMysqlExistsById(id, this.options);
    const result = await executeMysqlQuery(
      this.options,
      query.text,
      query.values,
    );

    return Boolean(result.rows[0]?.exists);
  };

  count = async (): Promise<number> => {
    const query = compileMysqlCount(this.options);
    const result = await executeMysqlQuery(
      this.options,
      query.text,
      query.values,
    );

    return Number(result.rows[0]?.count ?? 0);
  };

  save = async (entity: TEntity): Promise<TEntity> => {
    const id = getMysqlPrimaryKeyValue(entity, this.options);

    if (id === null || id === undefined) {
      return this.persistEntity(entity);
    }

    return (await this.updateEntity(entity)) ?? this.persistEntity(entity);
  };

  private persistEntity = async (entity: TEntity): Promise<TEntity> => {
    const entityTarget = this.getEntityTarget();

    if (!entityTarget) {
      return this.insertEntity(entity);
    }

    const currentContext = getCurrentPersistenceContext();
    const context = currentContext ?? new PersistenceContext();
    const persisted = await context.persist(entity, {
      adapter: this.dirtyCheckAdapter,
      entity: entityTarget,
    });

    if (!currentContext) {
      await context.flush();
    }

    return persisted;
  };

  private insertEntity = async (entity: TEntity): Promise<TEntity> => {
    const query = compileMysqlInsert(entity, this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );
    const id = getMysqlPrimaryKeyValue(entity, this.options) ?? result.insertId;

    if (id === null || id === undefined) {
      return this.attachLazy([entity])[0];
    }

    return this.manage(this.attachLazy([(await this.findByIdRow(id as TId)) ?? entity])[0]);
  };

  private updateEntity = async (entity: TEntity): Promise<TEntity | null> => {
    const id = getMysqlPrimaryKeyValue(entity, this.options);
    return this.updateEntityById(
      id as TId,
      withUpdatedAtTimestamp(entity, this.options.entity, new Date(), {
        overwrite: true,
      }),
    );
  };

  private updateEntityById = async (
    id: TId,
    patch: Partial<TEntity>,
  ): Promise<TEntity | null> => {
    const expectedVersion = readExpectedVersionFromPatch(
      patch,
      this.options.entity,
    );
    const touchedPatch = withUpdatedAtTimestamp(patch, this.options.entity);
    const query = expectedVersion === undefined
      ? compileMysqlUpdate(id, touchedPatch, this.options)
      : compileMysqlVersionedUpdate(id, touchedPatch, expectedVersion, this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );

    if (result.affectedRows === 0) {
      return null;
    }

    const row = await this.findByIdRow(id);
    return this.manage(row ? this.attachLazy([row])[0] : null);
  };

  remove = async (entity: TEntity): Promise<void> => {
    const entityTarget = this.getEntityTarget();

    if (!entityTarget) {
      await this.delete(entity);
      return;
    }

    const currentContext = getCurrentPersistenceContext();
    const context = currentContext ?? new PersistenceContext();
    await context.remove(entity, {
      adapter: this.dirtyCheckAdapter,
      entity: entityTarget,
    });

    if (!currentContext) {
      await context.flush();
    }
  };

  delete = async (entityOrId: TEntity | TId): Promise<number> => {
    const id =
      typeof entityOrId === "object" && entityOrId !== null
        ? getMysqlPrimaryKeyValue(entityOrId, this.options)
        : entityOrId;

    return this.deleteById(id as TId);
  };

  deleteById = async (id: TId): Promise<number> => {
    if (this.shouldUseOrmDelete()) {
      const entity = await this.findById(id, this.removeCascadeLoad());

      if (!entity) {
        return 0;
      }

      return this.removeLoadedEntities([entity]);
    }

    const query = compileMysqlDeleteById(id, this.options);
    const result = await executeMysqlQuery(this.options, query.text, query.values);
    const deletedCount = result.affectedRows ?? 0;

    if (deletedCount > 0) {
      this.detachById(id);
    }

    return deletedCount;
  };

  deleteAll = async (): Promise<number> => {
    if (this.shouldUseOrmDelete()) {
      return this.removeLoadedEntities(
        await this.findAll(this.removeCascadeLoad()) as TEntity[],
      );
    }

    const query = compileMysqlDeleteAll(this.options);
    const result = await executeMysqlQuery(this.options, query.text, query.values);
    this.detachAll();

    return result.affectedRows ?? 0;
  };

  private async executePageQuery(
    invocation: RepositoryMethodInvocation,
    load: NPALoadOptions<TEntity> | undefined,
  ): Promise<Page<TEntity> | CursorPage<TEntity>> {
    const pageable = invocation.pageable;

    if (!pageable) {
      throw new NPAPaginationError("Page query requires Pageable.", {
        code: "NPA_CURSOR_METADATA_REQUIRED",
      });
    }

    const query = compileMysqlQuery(invocation, this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );

    if (isOffsetPageable(pageable)) {
      const rows = await this.loadRelations(result.rows, load);
      const countQuery = compileMysqlQuery(
        {
          query: {
            ...invocation.query,
            action: "count",
            limit: undefined,
            orderBy: [],
          },
          args: invocation.args,
        },
        this.options,
      );
      const countResult = await executeMysqlQuery(
        this.options,
        countQuery.text,
        countQuery.values,
      );

      return createPage(
        this.manageMany(this.attachLazy(rows)),
        pageable,
        Number(countResult.rows[0]?.count ?? 0),
      );
    }

    if (!isCursorPageable(pageable) || !query.cursor) {
      throw new NPAPaginationError("Cursor page query requires cursor metadata.", {
        code: "NPA_CURSOR_METADATA_REQUIRED",
      });
    }

    const window = createCursorWindow(result.rows, query.cursor);
    const rows = stripCursorKeys(window.content, query.cursor);

    const loaded = await this.loadRelations(rows, load);

    return {
      ...window,
      content: this.manageMany(this.attachLazy(loaded)),
    };
  }

  private formatRawQueryResult(
    query: { result: string; managed: boolean },
    rows: TEntity[],
    affectedRows: number,
  ): unknown {
    switch (query.result) {
      case "many":
        return query.managed ? this.manageMany(this.attachLazy(rows)) : rows;
      case "one": {
        const row = rows[0] ?? null;
        return query.managed ? this.manage(row ? this.attachLazy([row])[0] : null) : row;
      }
      case "scalar":
        return firstColumn(rows[0] ?? null);
      case "execute":
        return affectedRows;
      default:
        throw new NPAQueryError(`Unsupported @Query result mode: ${query.result}`, {
          code: "NPA_RAW_QUERY_RESULT_MODE_UNSUPPORTED",
          details: { result: query.result },
        });
    }
  }

  private async findByIdRow(id: TId): Promise<TEntity | null> {
    const query = compileMysqlFindById(id, this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );

    return result.rows[0] ?? null;
  }

  private manage(entity: TEntity): TEntity;
  private manage(entity: null): null;
  private manage(entity: TEntity | null): TEntity | null;
  private manage(entity: TEntity | null): TEntity | null {
    const context = getCurrentPersistenceContext();

    const entityTarget = this.getEntityTarget();

    if (!context || !entityTarget || !entity) {
      return entity;
    }

    return context.manage(entity, {
      adapter: this.dirtyCheckAdapter,
      entity: entityTarget,
    });
  }

  private manageMany(entities: TEntity[]): TEntity[] {
    const context = getCurrentPersistenceContext();

    const entityTarget = this.getEntityTarget();

    if (!context || !entityTarget) {
      return entities;
    }

    return context.manageMany(entities, {
      adapter: this.dirtyCheckAdapter,
      entity: entityTarget,
    });
  }

  private attachLazy(entities: TEntity[]): TEntity[] {
    return this.attachLazyFor(entities, this.getEntityTarget());
  }

  private attachLazyFor<TTarget extends object>(
    entities: TTarget[],
    entity: EntityTarget<TTarget> | undefined,
  ): TTarget[] {
    return attachMysqlLazyRelations(entities.filter((target) => target), {
      entity,
      preferExecute: this.options.preferExecute,
      queryable: this.options.queryable,
    });
  }

  private findManagedById(id: TId): TEntity | undefined {
    const context = getCurrentPersistenceContext();
    const entityTarget = this.getEntityTarget();

    if (!context || !entityTarget) {
      return undefined;
    }

    return context.findManagedById(id, {
      adapter: this.dirtyCheckAdapter,
      entity: entityTarget,
    });
  }

  private async loadRelations(
    entities: TEntity[],
    load: NPALoadOptions<TEntity> | undefined,
  ): Promise<TEntity[]> {
    const entity = this.getEntityTarget();

    return loadMysqlRelations(entities, {
      entity,
      load: withEagerRelations(entity, load),
      preferExecute: this.options.preferExecute,
      queryable: this.options.queryable,
    });
  }

  private detachById(id: TId): void {
    const context = getCurrentPersistenceContext();

    const entityTarget = this.getEntityTarget();

    if (!context || !entityTarget) {
      return;
    }

    context.detachById(id, {
      adapter: this.dirtyCheckAdapter,
      entity: entityTarget,
    });
  }

  private detachAll(): void {
    const context = getCurrentPersistenceContext();

    const entityTarget = this.getEntityTarget();

    if (!context || !entityTarget) {
      return;
    }

    context.detachAll({
      adapter: this.dirtyCheckAdapter,
      entity: entityTarget,
    });
  }

  private async executeOrmDerivedDelete(
    invocation: Parameters<RepositoryMethodExecutor>[0],
  ): Promise<number> {
    const query = compileMysqlQuery({
      ...invocation,
      query: {
        ...invocation.query,
        action: "find",
        distinct: true,
      },
    }, this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );
    const loaded = await this.loadRelations(result.rows, this.removeCascadeLoad());
    return this.removeLoadedEntities(this.attachLazy(loaded));
  }

  private async removeLoadedEntities(entities: TEntity[]): Promise<number> {
    const entityTarget = this.getEntityTarget();

    if (!entityTarget) {
      return 0;
    }

    const currentContext = getCurrentPersistenceContext();
    const context = currentContext ?? new PersistenceContext();

    for (const entity of entities) {
      await context.remove(entity, {
        adapter: this.dirtyCheckAdapter,
        entity: entityTarget,
      });
    }

    if (!currentContext) {
      await context.flush();
    }

    return entities.length;
  }

  private shouldUseOrmDelete(): boolean {
    const entityTarget = this.getEntityTarget();
    return !!entityTarget && needsOrmDelete(getEntityMetadata(entityTarget));
  }

  private removeCascadeLoad(): NPALoadOptions<TEntity> | undefined {
    const entityTarget = this.getEntityTarget();

    if (!entityTarget) {
      return undefined;
    }

    const relations = removeCascadeRelationTree(getEntityMetadata(entityTarget));
    return relations ? { relations } as NPALoadOptions<TEntity> : undefined;
  }

  private getEntityTarget(): EntityTarget<TEntity> | undefined {
    return this.options.entity as EntityTarget<TEntity> | undefined;
  }

  private createDirtyCheckAdapter<TTarget extends object>(
    entity: EntityTarget<TTarget> | undefined,
  ): NPADirtyCheckAdapter<TTarget> {
    const options = this.optionsFor(entity);

    return {
      updateDirty: async (_entity, id, patch, updateOptions) => {
        const touchedPatch = withUpdatedAtTimestamp(patch, entity);
        const query = updateOptions?.versionColumn
          ? compileMysqlVersionedUpdate(
            id,
            touchedPatch,
            updateOptions.expectedVersion,
            options,
          )
          : compileMysqlUpdate(id, touchedPatch, options);
        const result = await executeMysqlQuery<TTarget>(
          options,
          query.text,
          query.values,
        );

        if (result.affectedRows === 0) {
          return null;
        }

        const row = await this.findByIdRowFor(id, options, entity);
        return row ? this.attachLazyFor([row], entity)[0] : null;
      },
      insertManaged: async (targetEntity) => {
        const query = compileMysqlInsert(targetEntity, options);
        const result = await executeMysqlQuery<TTarget>(
          options,
          query.text,
          query.values,
        );
        const id = getMysqlPrimaryKeyValue(targetEntity, options) ?? result.insertId;

        if (id === null || id === undefined) {
          return this.attachLazyFor([targetEntity], entity)[0];
        }

        return this.attachLazyFor(
          [(await this.findByIdRowFor(id, options, entity)) ?? targetEntity],
          entity,
        )[0];
      },
      deleteManaged: async (_targetEntity, id) => {
        const query = compileMysqlDeleteById(id, options);
        const result = await executeMysqlQuery(options, query.text, query.values);
        return result.affectedRows ?? 0;
      },
      syncManyToManyRelations: async (_targetEntity, id, relation, targetIds) => {
        const metadata = requireAdapterMetadata(entity, "MySQL", "sync many-to-many relations");
        const join = resolveManyToManyJoin(metadata, relation, qualifiedJoinTable);
        const targetMetadata = getEntityMetadata(relation.target());
        const sourceIdColumns = primaryColumnsOf(metadata);
        const targetIdColumns = primaryColumnsOf(targetMetadata);
        const sourceColumns = relation.mappedBy ? join.targetColumns : join.sourceColumns;
        const targetColumns = relation.mappedBy ? join.sourceColumns : join.targetColumns;
        const sourceWhere = compileTupleWhere(sourceColumns, id, sourceIdColumns, {
          placeholder: () => "?",
          quoteIdentifier: quoteMysqlIdentifier,
        });
        await executeMysqlQuery(
          options,
          `DELETE FROM ${join.table} WHERE ${sourceWhere.sql}`,
          sourceWhere.values,
        );

        if (targetIds.length === 0) {
          return;
        }

        const columns = [...sourceColumns, ...targetColumns];
        const rows = targetIds.map((targetId) => [
          ...idParts(id, sourceIdColumns),
          ...idParts(targetId, targetIdColumns),
        ]);
        const placeholders = rows.map((row) =>
          `(${row.map(() => "?").join(", ")})`).join(", ");
        await executeMysqlQuery(
          options,
          `INSERT IGNORE INTO ${join.table} (${columns.map(quoteMysqlIdentifier).join(", ")}) VALUES ${placeholders}`,
          rows.flat(),
        );
      },
      deleteManyToManyRelations: async (_targetEntity, id, relation) => {
        const metadata = requireAdapterMetadata(entity, "MySQL", "delete many-to-many relations");
        const join = resolveManyToManyJoin(metadata, relation, qualifiedJoinTable);
        const sourceIdColumns = primaryColumnsOf(metadata);
        const columns = relation.mappedBy ? join.targetColumns : join.sourceColumns;
        const where = compileTupleWhere(columns, id, sourceIdColumns, {
          placeholder: () => "?",
          quoteIdentifier: quoteMysqlIdentifier,
        });
        await executeMysqlQuery(
          options,
          `DELETE FROM ${join.table} WHERE ${where.sql}`,
          where.values,
        );
      },
      forEntity: (target) => this.createDirtyCheckAdapter(target),
    };
  }

  private async findByIdRowFor<TTarget extends object>(
    id: unknown,
    options: MysqlRepositoryOptions,
    _entity: EntityTarget<TTarget> | undefined,
  ): Promise<TTarget | null> {
    const query = compileMysqlFindById(id, options);
    const result = await executeMysqlQuery<TTarget>(
      options,
      query.text,
      query.values,
    );

    return result.rows[0] ?? null;
  }

  private optionsFor<TTarget extends object>(
    entity: EntityTarget<TTarget> | undefined,
  ): MysqlRepositoryOptions {
    if (!entity || entity === this.options.entity) {
      return { ...this.options, entity };
    }

    return {
      entity,
      operations: this.options.operations,
      preferExecute: this.options.preferExecute,
      queryable: this.options.queryable,
    };
  }
}

function qualifiedJoinTable(
  source: EntityMetadata,
  target: EntityMetadata,
  relation: RelationMetadata,
): string {
  return defaultQualifiedJoinTableName(source, target, relation, quoteMysqlQualifiedIdentifier);
}
