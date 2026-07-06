import {
  defaultJoinTableName,
  ColumnMetadata,
  createCursorWindow,
  createPage,
  EntityMetadata,
  getCurrentPersistenceContext,
  getEntityMetadata,
  getOptionalEntityMetadata,
  type EntityTarget,
  isCursorPageable,
  isOffsetPageable,
  joinTableColumnNames,
  needsOrmDelete,
  primaryColumnsOf,
  NPAFindOptions,
  NPAEntityGraphMetadata,
  NPARepositoryAdapter,
  NPADirtyCheckAdapter,
  NPALoadOptions,
  Page,
  CursorPage,
  PersistenceContext,
  RelationKind,
  RelationMetadata,
  removeCascadeRelationTree,
  RepositoryMethodExecutor,
  RepositoryMethodInvocation,
  RepositoryRawQueryExecutor,
  stripCursorKeys,
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
      throw new Error(`Query method "${invocation.query.methodName}" only supports Pageable on find queries.`);
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

  persist = async (entity: TEntity): Promise<TEntity> => {
    const entityTarget = this.getEntityTarget();

    if (!entityTarget) {
      return this.insert(entity);
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

  save = async (
    entity: TEntity,
  ): Promise<TEntity | null> => {
    const id = getPrimaryKeyValue(entity, this.options);
    return id === null || id === undefined
      ? this.insert(entity)
      : this.update(entity);
  };

  insert = async (entity: TEntity): Promise<TEntity> => {
    const query = compilePostgresqlInsert(entity, this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    const inserted = result.rows[0];

    if (!inserted) {
      throw new Error("PostgreSQL insert did not return a row.");
    }

    return this.manage(this.attachLazy([inserted])[0]);
  };

  update = async (
    entity: TEntity,
  ): Promise<TEntity | null> => {
    const id = getPrimaryKeyValue(entity, this.options);
    return this.updateById(
      id as TId,
      withUpdatedAtTimestamp(entity, this.options.entity, new Date(), {
        overwrite: true,
      }),
    );
  };

  updateById = async (
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
      throw new Error("Page query requires Pageable.");
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
      throw new Error("Cursor page query requires cursor metadata.");
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
        throw new Error(`Unsupported @Query result mode: ${query.result}`);
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
          throw new Error("PostgreSQL insert did not return a row.");
        }

        return this.attachLazyFor([inserted], entity)[0];
      },
      deleteManaged: async (_targetEntity, id) => {
        const query = compilePostgresqlDeleteById(id, options);
        const result = await this.options.queryable.query(query.text, query.values);
        return result.rowCount ?? 0;
      },
      syncManyToManyRelations: async (_targetEntity, id, relation, targetIds) => {
        const metadata = requireAdapterMetadata(entity, "sync many-to-many relations");
        const join = manyToManyJoin(metadata, relation);
        const targetMetadata = getEntityMetadata(relation.target());
        const sourceIdColumns = primaryColumnsOf(metadata);
        const targetIdColumns = primaryColumnsOf(targetMetadata);
        const sourceColumns = relation.mappedBy ? join.targetColumns : join.sourceColumns;
        const targetColumns = relation.mappedBy ? join.sourceColumns : join.targetColumns;
        const sourceWhere = compileTupleWhere(sourceColumns, id, sourceIdColumns, 1);
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
        const metadata = requireAdapterMetadata(entity, "delete many-to-many relations");
        const join = manyToManyJoin(metadata, relation);
        const sourceIdColumns = primaryColumnsOf(metadata);
        const columns = relation.mappedBy ? join.targetColumns : join.sourceColumns;
        const where = compileTupleWhere(columns, id, sourceIdColumns, 1);
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

function firstColumn(row: object | null): unknown {
  if (!row) {
    return null;
  }

  const [value] = Object.values(row);
  return value ?? null;
}

interface ManyToManyJoin {
  table: string;
  sourceColumns: string[];
  targetColumns: string[];
}

function manyToManyJoin(
  source: EntityMetadata,
  relation: RelationMetadata,
): ManyToManyJoin {
  const target = getEntityMetadata(relation.target());

  if (relation.mappedBy) {
    const owner = target.relations.find((candidate) =>
      candidate.kind === RelationKind.MANY_TO_MANY &&
      candidate.propertyName === relation.mappedBy,
    );

    if (!owner) {
      throw new Error(`@ManyToMany ${source.target.name}.${relation.propertyName} mappedBy relation was not found.`);
    }

    return {
      table: qualifiedJoinTable(target, source, owner),
      sourceColumns: joinTableColumnNames(target).map((column) => column.joinColumnName),
      targetColumns: joinTableColumnNames(source).map((column) => column.joinColumnName),
    };
  }

  return {
    table: qualifiedJoinTable(source, target, relation),
    sourceColumns: joinTableColumnNames(source).map((column) => column.joinColumnName),
    targetColumns: joinTableColumnNames(target).map((column) => column.joinColumnName),
  };
}

function compileTupleWhere(
  columns: string[],
  id: unknown,
  idColumns: ColumnMetadata[],
  startIndex: number,
): { sql: string; values: unknown[] } {
  const values = idParts(id, idColumns);

  if (columns.length !== values.length) {
    throw new Error(
      `Expected ${columns.length} id value(s), received ${values.length}.`,
    );
  }

  if (columns.length === 1) {
    return {
      sql: `${quoteIdentifier(columns[0])} = $${startIndex}`,
      values,
    };
  }

  return {
    sql: `(${columns.map(quoteIdentifier).join(", ")}) = (${values.map((_, index) => `$${startIndex + index}`).join(", ")})`,
    values,
  };
}

function idParts(id: unknown, columns: ColumnMetadata[] = []): unknown[] {
  if (columns.length > 0) {
    if (columns.length === 1 && !isRecord(id)) {
      return [id];
    }

    if (!isRecord(id)) {
      throw new Error(
        `Expected object id with ${columns.length} value(s), received scalar id.`,
      );
    }

    return columns.map((column) =>
      column.propertyName in id ? id[column.propertyName] : id[column.columnName]);
  }

  if (!isRecord(id)) {
    return [id];
  }

  return Object.keys(id).sort().map((key) => id[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function qualifiedJoinTable(
  source: EntityMetadata,
  target: EntityMetadata,
  relation: RelationMetadata,
): string {
  const rawName = relation.joinTable ?? defaultJoinTableName(source, target);
  const separatorIndex = rawName.indexOf(".");

  if (separatorIndex > 0) {
    return `${quoteQualifiedIdentifier(rawName.slice(0, separatorIndex))}.${quoteQualifiedIdentifier(rawName.slice(separatorIndex + 1))}`;
  }

  const table = quoteQualifiedIdentifier(rawName);
  const schema = source.schema ?? target.schema;
  return schema ? `${quoteQualifiedIdentifier(schema)}.${table}` : table;
}

function requireAdapterMetadata<TEntity extends object>(
  entity: EntityTarget<TEntity> | undefined,
  operation: string,
): EntityMetadata {
  if (!entity) {
    throw new Error(`PostgreSQL ${operation} requires entity metadata.`);
  }

  return getEntityMetadata(entity);
}

function toEntityGraphLoad<TEntity extends object>(
  entityGraph: NPAEntityGraphMetadata<TEntity> | undefined,
): NPALoadOptions<TEntity> | undefined {
  return entityGraph ? { relations: entityGraph.relations } : undefined;
}

function findAllInvocation<TEntity extends object>(
  load: NPAFindOptions<TEntity> | undefined,
): RepositoryMethodInvocation {
  return {
    query: {
      methodName: "findAll",
      action: "find",
      predicate: [],
      orderBy: (load?.orderBy ?? []).map((order) => ({
        property: order.property,
        direction: normalizeOrderDirection(order.direction),
      })),
      parameterCount: 0,
    },
    args: [],
    pageable: load?.pageable,
  };
}

function normalizeOrderDirection(direction: unknown): "asc" | "desc" {
  if (direction === undefined) {
    return "asc";
  }

  if (direction === "asc" || direction === "desc") {
    return direction;
  }

  throw new Error(`Unsupported order direction "${String(direction)}".`);
}

function readExpectedVersionFromPatch(
  patch: object,
  entity: EntityTarget | undefined,
): unknown {
  const versionColumn = getOptionalEntityMetadata(entity)?.versionColumn;

  if (!versionColumn) {
    return undefined;
  }

  const record = patch as Record<string, unknown>;

  if (versionColumn.propertyName in record) {
    return record[versionColumn.propertyName];
  }

  if (versionColumn.columnName in record) {
    return record[versionColumn.columnName];
  }

  return undefined;
}
