import {
  getCurrentPersistenceContext,
  type EntityTarget,
  NPARepositoryAdapter,
  NPADirtyCheckAdapter,
  RepositoryMethodExecutor,
} from "@honeybeaers/npa";
import {
  compilePostgresqlCount,
  compilePostgresqlDeleteAll,
  compilePostgresqlDeleteById,
  compilePostgresqlExistsById,
  compilePostgresqlFindAll,
  compilePostgresqlFindById,
  compilePostgresqlInsert,
  compilePostgresqlUpdate,
  getPrimaryKeyValue,
} from "./postgresql-crud-compiler";
import { compilePostgresqlQuery } from "./postgresql-query-compiler";
import { PostgresqlRepositoryOptions } from "./types";

export class PostgresqlRepositoryExecutor<TEntity extends object, TId = unknown>
  implements NPARepositoryAdapter<TEntity, TId>
{
  private readonly dirtyCheckAdapter: NPADirtyCheckAdapter<TEntity> = {
    updateDirty: async (_entity, id, patch) => {
      const query = compilePostgresqlUpdate(id, patch, this.options);
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

  execute = this.executeDerivedQuery;

  findById = async (id: TId): Promise<TEntity | null> => {
    const query = compilePostgresqlFindById(id, this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    return this.manage(result.rows[0] ?? null);
  };

  findAll = async (): Promise<TEntity[]> => {
    const query = compilePostgresqlFindAll(this.options);
    const result = await this.options.queryable.query<TEntity>(
      query.text,
      query.values,
    );

    return this.manageMany(result.rows);
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
