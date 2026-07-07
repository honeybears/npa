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
  NPADatabaseError,
  NPAFindOptions,
  NPAPaginationError,
  NPAQueryError,
  NPARepositoryAdapter,
  NPADirtyCheckAdapter,
  NPALoadOptions,
  Page,
  CursorPage,
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
  compilePostgresqlCount,
  compilePostgresqlDeleteAll,
  compilePostgresqlDeleteById,
  compilePostgresqlExistsById,
  compilePostgresqlFindAll,
  compilePostgresqlFindById,
  compilePostgresqlInsert,
  compilePostgresqlUpdate,
  compilePostgresqlVersionedUpdate,
  getPrimaryKeyValue,
} from "./postgresql-crud-compiler";
import { quoteIdentifier, quoteQualifiedIdentifier } from "./postgresql-identifiers";
import { compilePostgresqlQuery } from "./postgresql-query-compiler";
import { compilePostgresqlRawQuery } from "./postgresql-raw-query";
import { instrumentPostgresqlQueryable } from "./postgresql-operations";
import {
  attachPostgresqlLazyRelations,
  loadPostgresqlRelations,
} from "./postgresql-relation-loader";
import { PostgresqlRepositoryOptions } from "./types";

export class PostgresqlRepositoryExecutor<TEntity extends object, TId = unknown>
  implements NPARepositoryAdapter<TEntity, TId>
{
  private readonly dirtyCheckAdapter: NPADirtyCheckAdapter<TEntity>;
  private readonly options: PostgresqlRepositoryOptions;

  constructor(options: PostgresqlRepositoryOptions) {
    this.options = {
      ...options,
      queryable: instrumentPostgresqlQueryable(
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

    const query = compilePostgresqlQuery(invocation, this.options);
    const result = await this.options.queryable.query(query.text, query.values);

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
        const deletedCount = result.rowCount ?? 0;

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
    const query = compilePostgresqlRawQuery(
      invocation.query.text,
      invocation.args,
      invocation.methodName,
    );
    const result = await this.options.queryable.query(query.text, query.values);

    const rows = await this.loadRelations(
      result.rows as TEntity[],
      toEntityGraphLoad(invocation.entityGraph),
    );

    return this.formatRawQueryResult(
      invocation.query,
      rows,
      result.rowCount ?? 0,
    );
  };

  execute = this.executeDerivedQuery;

  findById = async (id: TId, load?: NPALoadOptions<TEntity>): Promise<TEntity | null> => {
    const managed = this.findManagedById(id);

    if (managed) {
      const loaded = await this.loadRelations(this.attachLazy([managed]), load);
      return this.manage(loaded[0] ?? null);
    }

    const query = compilePostgresqlFindById(id, this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    const loaded = await this.loadRelations(result.rows, load);
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
      const query = compilePostgresqlQuery(invocation, this.options);
      const result = await this.options.queryable.query<TEntity>(
        query.text,
        query.values,
      );

      return this.manageMany(this.attachLazy(await this.loadRelations(result.rows, load)));
    }

    const query = compilePostgresqlFindAll(this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    return this.manageMany(this.attachLazy(await this.loadRelations(result.rows, load)));
  };

  existsById = async (id: TId): Promise<boolean> => {
    const query = compilePostgresqlExistsById(id, this.options);
    const result = await this.options.queryable.query(query.text, query.values);

    return Boolean(result.rows[0]?.exists);
  };

  count = async (): Promise<number> => {
    const query = compilePostgresqlCount(this.options);
    const result = await this.options.queryable.query(query.text, query.values);

    return Number(result.rows[0]?.count ?? 0);
  };

  save = async (
    entity: TEntity,
  ): Promise<TEntity> => {
    const id = getPrimaryKeyValue(entity, this.options);

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
    const query = compilePostgresqlInsert(entity, this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    const inserted = result.rows[0];

    if (!inserted) {
      throw new NPADatabaseError("PostgreSQL insert did not return a row.", {
        code: "NPA_DATABASE_INSERT_RETURN_FAILED",
      });
    }

    return this.manage(this.attachLazy([inserted])[0]);
  };

  private updateEntity = async (
    entity: TEntity,
  ): Promise<TEntity | null> => {
    const id = getPrimaryKeyValue(entity, this.options);
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
      ? compilePostgresqlUpdate(id, touchedPatch, this.options)
      : compilePostgresqlVersionedUpdate(id, touchedPatch, expectedVersion, this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    return this.manage(this.attachLazy(result.rows)[0] ?? null);
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

  delete = async (
    entityOrId: TEntity | TId,
  ): Promise<number> => {
    const id =
      typeof entityOrId === "object" && entityOrId !== null
        ? getPrimaryKeyValue(entityOrId, this.options)
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

    const query = compilePostgresqlDeleteById(id, this.options);
    const result = await this.options.queryable.query(query.text, query.values);
    const deletedCount = result.rowCount ?? 0;

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

    const query = compilePostgresqlDeleteAll(this.options);
    const result = await this.options.queryable.query(query.text, query.values);
    this.detachAll();

    return result.rowCount ?? 0;
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

    const query = compilePostgresqlQuery(invocation, this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    if (isOffsetPageable(pageable)) {
      const rows = await this.loadRelations(result.rows, load);
      const countQuery = compilePostgresqlQuery(
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
      const countResult = await this.options.queryable.query(countQuery.text, countQuery.values);

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
    return attachPostgresqlLazyRelations(entities, {
      entity,
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

    return loadPostgresqlRelations(entities, {
      entity,
      load: withEagerRelations(entity, load),
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
    const query = compilePostgresqlQuery({
      ...invocation,
      query: {
        ...invocation.query,
        action: "find",
        distinct: true,
      },
    }, this.options);
    const result = await this.options.queryable.query<TEntity>(
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
          ? compilePostgresqlVersionedUpdate(
            id,
            touchedPatch,
            updateOptions.expectedVersion,
            options,
          )
          : compilePostgresqlUpdate(id, touchedPatch, options);
        const result = await this.options.queryable.query<TTarget>(
          query.text,
          query.values,
        );

        return this.attachLazyFor(result.rows, entity)[0] ?? null;
      },
      insertManaged: async (targetEntity) => {
        const query = compilePostgresqlInsert(targetEntity, options);
        const result = await this.options.queryable.query<TTarget>(
          query.text,
          query.values,
        );
        const inserted = result.rows[0];

        if (!inserted) {
          throw new NPADatabaseError("PostgreSQL insert did not return a row.", {
            code: "NPA_DATABASE_INSERT_RETURN_FAILED",
          });
        }

        return this.attachLazyFor([inserted], entity)[0];
      },
      deleteManaged: async (_targetEntity, id) => {
        const query = compilePostgresqlDeleteById(id, options);
        const result = await this.options.queryable.query(query.text, query.values);
        return result.rowCount ?? 0;
      },
      syncManyToManyRelations: async (_targetEntity, id, relation, targetIds) => {
        const metadata = requireAdapterMetadata(entity, "PostgreSQL", "sync many-to-many relations");
        const join = resolveManyToManyJoin(metadata, relation, qualifiedJoinTable);
        const targetMetadata = getEntityMetadata(relation.target());
        const sourceIdColumns = primaryColumnsOf(metadata);
        const targetIdColumns = primaryColumnsOf(targetMetadata);
        const sourceColumns = relation.mappedBy ? join.targetColumns : join.sourceColumns;
        const targetColumns = relation.mappedBy ? join.sourceColumns : join.targetColumns;
        const sourceWhere = compileTupleWhere(sourceColumns, id, sourceIdColumns, {
          placeholder: (index) => `$${index}`,
          quoteIdentifier,
          startIndex: 1,
        });
        await this.options.queryable.query(
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
        let index = 1;
        const placeholders = rows.map((row) =>
          `(${row.map(() => `$${index++}`).join(", ")})`);
        await this.options.queryable.query(
          `INSERT INTO ${join.table} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${placeholders.join(", ")} ON CONFLICT DO NOTHING`,
          rows.flat(),
        );
      },
      deleteManyToManyRelations: async (_targetEntity, id, relation) => {
        const metadata = requireAdapterMetadata(entity, "PostgreSQL", "delete many-to-many relations");
        const join = resolveManyToManyJoin(metadata, relation, qualifiedJoinTable);
        const sourceIdColumns = primaryColumnsOf(metadata);
        const columns = relation.mappedBy ? join.targetColumns : join.sourceColumns;
        const where = compileTupleWhere(columns, id, sourceIdColumns, {
          placeholder: (index) => `$${index}`,
          quoteIdentifier,
          startIndex: 1,
        });
        await this.options.queryable.query(
          `DELETE FROM ${join.table} WHERE ${where.sql}`,
          where.values,
        );
      },
      forEntity: (target) => this.createDirtyCheckAdapter(target),
    };
  }

  private optionsFor<TTarget extends object>(
    entity: EntityTarget<TTarget> | undefined,
  ): PostgresqlRepositoryOptions {
    if (!entity || entity === this.options.entity) {
      return { ...this.options, entity };
    }

    return {
      entity,
      operations: this.options.operations,
      queryable: this.options.queryable,
    };
  }
}

function qualifiedJoinTable(
  source: EntityMetadata,
  target: EntityMetadata,
  relation: RelationMetadata,
): string {
  return defaultQualifiedJoinTableName(source, target, relation, quoteQualifiedIdentifier);
}
