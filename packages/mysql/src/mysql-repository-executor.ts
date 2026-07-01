import {
  getCurrentPersistenceContext,
  type EntityTarget,
  NPARepositoryAdapter,
  NPADirtyCheckAdapter,
  RepositoryMethodExecutor,
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
import { compileMysqlQuery } from "./mysql-query-compiler";
import { loadMysqlRelations } from "./mysql-relation-loader";
import { executeMysqlQuery } from "./mysql-result";
import { MysqlRepositoryOptions } from "./types";

export class MysqlRepositoryExecutor<TEntity extends object, TId = unknown>
  implements NPARepositoryAdapter<TEntity, TId>
{
  private readonly dirtyCheckAdapter: NPADirtyCheckAdapter<TEntity> = {
    updateDirty: async (_entity, id, patch, updateOptions) => {
      const query = updateOptions?.versionColumn
        ? compileMysqlVersionedUpdate(
          id,
          patch,
          updateOptions.expectedVersion,
          this.options,
        )
        : compileMysqlUpdate(id, patch, this.options);
      const result = await executeMysqlQuery<TEntity>(
        this.options,
        query.text,
        query.values,
      );

      if (result.affectedRows === 0) {
        return null;
      }

      return this.findByIdRow(id as TId);
    },
  };

  constructor(private readonly options: MysqlRepositoryOptions) {}

  executeDerivedQuery: RepositoryMethodExecutor<Promise<unknown>> = async (
    invocation,
  ) => {
    const query = compileMysqlQuery(invocation, this.options);
    const result = await executeMysqlQuery(
      this.options,
      query.text,
      query.values,
    );

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
        const deletedCount = result.affectedRows ?? 0;

        if (deletedCount > 0) {
          this.detachAll();
        }

        return deletedCount;
      }
    }
  };

  findById = async (id: TId, load?: { relations?: true | string[] }): Promise<TEntity | null> => {
    const row = await this.findByIdRow(id);
    const loaded = await this.loadRelations(row ? [row] : [], load);

    return this.manage(loaded[0] ?? null);
  };

  findAll = async (load?: { relations?: true | string[] }): Promise<TEntity[]> => {
    const query = compileMysqlFindAll(this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );

    return this.manageMany(await this.loadRelations(result.rows, load));
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

  save = async (entity: TEntity): Promise<TEntity | null> => {
    const id = getMysqlPrimaryKeyValue(entity, this.options);
    return id === null || id === undefined
      ? this.insert(entity)
      : this.update(entity);
  };

  insert = async (entity: TEntity): Promise<TEntity> => {
    const query = compileMysqlInsert(entity, this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );
    const id = getMysqlPrimaryKeyValue(entity, this.options) ?? result.insertId;

    if (id === null || id === undefined) {
      return entity;
    }

    return this.manage((await this.findByIdRow(id as TId)) ?? entity);
  };

  update = async (entity: TEntity): Promise<TEntity | null> => {
    const id = getMysqlPrimaryKeyValue(entity, this.options);
    return this.updateById(id as TId, entity);
  };

  updateById = async (
    id: TId,
    patch: Partial<TEntity>,
  ): Promise<TEntity | null> => {
    const query = compileMysqlUpdate(id, patch, this.options);
    const result = await executeMysqlQuery<TEntity>(
      this.options,
      query.text,
      query.values,
    );

    if (result.affectedRows === 0) {
      return null;
    }

    return this.manage(await this.findByIdRow(id));
  };

  delete = async (entityOrId: TEntity | TId): Promise<number> => {
    const id =
      typeof entityOrId === "object" && entityOrId !== null
        ? getMysqlPrimaryKeyValue(entityOrId, this.options)
        : entityOrId;

    return this.deleteById(id as TId);
  };

  deleteById = async (id: TId): Promise<number> => {
    const query = compileMysqlDeleteById(id, this.options);
    const result = await executeMysqlQuery(this.options, query.text, query.values);
    const deletedCount = result.affectedRows ?? 0;

    if (deletedCount > 0) {
      this.detachById(id);
    }

    return deletedCount;
  };

  deleteAll = async (): Promise<number> => {
    const query = compileMysqlDeleteAll(this.options);
    const result = await executeMysqlQuery(this.options, query.text, query.values);
    this.detachAll();

    return result.affectedRows ?? 0;
  };

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

  private async loadRelations(
    entities: TEntity[],
    load: { relations?: true | string[] } | undefined,
  ): Promise<TEntity[]> {
    return loadMysqlRelations(entities, {
      entity: this.getEntityTarget(),
      load,
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

  private getEntityTarget(): EntityTarget<TEntity> | undefined {
    return this.options.entity as EntityTarget<TEntity> | undefined;
  }
}
