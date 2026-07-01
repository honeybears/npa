import {
  getCurrentPersistenceContext,
  type EntityTarget,
  NPARepositoryAdapter,
  NPADirtyCheckAdapter,
  RepositoryMethodExecutor,
  RepositoryRawQueryExecutor,
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
import { compilePostgresqlQuery } from "./postgresql-query-compiler";
import { compilePostgresqlRawQuery } from "./postgresql-raw-query";
import { loadPostgresqlRelations } from "./postgresql-relation-loader";
import { PostgresqlRepositoryOptions } from "./types";

export class PostgresqlRepositoryExecutor<TEntity extends object, TId = unknown>
  implements NPARepositoryAdapter<TEntity, TId>
{
  private readonly dirtyCheckAdapter: NPADirtyCheckAdapter<TEntity> = {
    updateDirty: async (_entity, id, patch, updateOptions) => {
      const query = updateOptions?.versionColumn
        ? compilePostgresqlVersionedUpdate(
          id,
          patch,
          updateOptions.expectedVersion,
          this.options,
        )
        : compilePostgresqlUpdate(id, patch, this.options);
      const result = await this.options.queryable.query<TEntity>(
        query.text,
        query.values,
      );

      return result.rows[0] ?? null;
    },
  };

  constructor(private readonly options: PostgresqlRepositoryOptions) {}

  executeDerivedQuery: RepositoryMethodExecutor<Promise<unknown>> = async (
    invocation,
  ) => {
    const query = compilePostgresqlQuery(invocation, this.options);
    const result = await this.options.queryable.query(query.text, query.values);

    switch (invocation.query.action) {
      case "find":
        return this.manageMany(result.rows as TEntity[]);
      case "findOne":
        return this.manage((result.rows[0] as TEntity | undefined) ?? null);
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

    return this.formatRawQueryResult(
      invocation.query,
      result.rows as TEntity[],
      result.rowCount ?? 0,
    );
  };

  execute = this.executeDerivedQuery;

  findById = async (id: TId, load?: { relations?: true | string[] }): Promise<TEntity | null> => {
    const query = compilePostgresqlFindById(id, this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    const loaded = await this.loadRelations(result.rows, load);
    return this.manage(loaded[0] ?? null);
  };

  findAll = async (load?: { relations?: true | string[] }): Promise<TEntity[]> => {
    const query = compilePostgresqlFindAll(this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    return this.manageMany(await this.loadRelations(result.rows, load));
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

    return this.manage(inserted);
  };

  update = async (
    entity: TEntity,
  ): Promise<TEntity | null> => {
    const id = getPrimaryKeyValue(entity, this.options);
    return this.updateById(id as TId, entity);
  };

  updateById = async (
    id: TId,
    patch: Partial<TEntity>,
  ): Promise<TEntity | null> => {
    const query = compilePostgresqlUpdate(id, patch, this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    return this.manage(result.rows[0] ?? null);
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
    const query = compilePostgresqlDeleteById(id, this.options);
    const result = await this.options.queryable.query(query.text, query.values);
    const deletedCount = result.rowCount ?? 0;

    if (deletedCount > 0) {
      this.detachById(id);
    }

    return deletedCount;
  };

  deleteAll = async (): Promise<number> => {
    const query = compilePostgresqlDeleteAll(this.options);
    const result = await this.options.queryable.query(query.text, query.values);
    this.detachAll();

    return result.rowCount ?? 0;
  };

  private formatRawQueryResult(
    query: { result: string; managed: boolean },
    rows: TEntity[],
    affectedRows: number,
  ): unknown {
    switch (query.result) {
      case "many":
        return query.managed ? this.manageMany(rows) : rows;
      case "one": {
        const row = rows[0] ?? null;
        return query.managed ? this.manage(row) : row;
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

  private async loadRelations(
    entities: TEntity[],
    load: { relations?: true | string[] } | undefined,
  ): Promise<TEntity[]> {
    return loadPostgresqlRelations(entities, {
      entity: this.getEntityTarget(),
      load,
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

  private getEntityTarget(): EntityTarget<TEntity> | undefined {
    return this.options.entity as EntityTarget<TEntity> | undefined;
  }
}

function firstColumn(row: object | null): unknown {
  if (!row) {
    return null;
  }

  const [value] = Object.values(row);
  return value ?? null;
}
