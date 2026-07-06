import {
  CascadeType,
  ColumnMetadata,
  EntityMetadata,
  EntityTarget,
  getEntityMetadata,
  readEntityPrimaryValue,
  readRelationForeignKeyValue,
  relationJoinColumns,
  RelationKind,
  RelationMetadata,
  primaryColumnsOf,
} from "../entity";
import { NPAMetadataError, NPAPersistenceError } from "../error";
import { OptimisticLockError } from "./optimistic-lock-error";
import { NPADirtyCheckAdapter, NPAManageEntityOptions } from "./types";

type EntitySnapshot = Map<string, unknown>;

interface ToManySnapshot {
  ids: unknown[];
  entities: object[];
}

interface ManagedEntity<TEntity extends object = object> {
  adapter: NPADirtyCheckAdapter<TEntity>;
  entity: TEntity;
  metadata: EntityMetadata;
  snapshot: EntitySnapshot;
}

export interface PersistenceContextOptions {
  readOnly?: boolean;
}

export class PersistenceContext {
  private readonly managed = new Map<object, ManagedEntity>();
  private readonly newEntities = new Set<object>();
  private readonly removedEntities = new Set<object>();
  private identityMap = new WeakMap<
    NPADirtyCheckAdapter,
    WeakMap<object, Map<string, ManagedEntity>>
  >();

  constructor(private readonly options: PersistenceContextOptions = {}) {}

  manage<TEntity extends object>(
    entity: TEntity,
    options: NPAManageEntityOptions<TEntity>,
  ): TEntity;
  manage<TEntity extends object>(
    entity: null,
    options: NPAManageEntityOptions<TEntity>,
  ): null;
  manage<TEntity extends object>(
    entity: undefined,
    options: NPAManageEntityOptions<TEntity>,
  ): undefined;
  manage<TEntity extends object>(
    entity: TEntity | null | undefined,
    options: NPAManageEntityOptions<TEntity>,
  ): TEntity | null | undefined {
    if (!entity) {
      return entity;
    }

    const metadata = getEntityMetadata(options.entity);
    requirePrimaryColumns(metadata);
    installColumnAliases(entity, metadata);
    const id = readEntityPrimaryValue(entity, metadata);
    const existing = !hasCompletePrimaryValue(id)
      ? undefined
      : this.findByIdentity(options.adapter, metadata.target, id);

    if (existing) {
      mergeManagedEntity(existing, entity);
      return existing.entity as TEntity;
    }

    const managed = {
      adapter: options.adapter,
      entity,
      metadata,
      snapshot: snapshotEntity(entity, metadata),
    };
    this.managed.set(entity, managed);
    this.rememberIdentity(options.adapter, metadata.target, id, managed);

    return entity;
  }

  persist<TEntity extends object>(
    entity: TEntity,
    options: NPAManageEntityOptions<TEntity>,
  ): Promise<TEntity> {
    this.assertWritable("persist");
    return this.persistCascade(entity, options, new Set());
  }

  remove<TEntity extends object>(
    entity: TEntity,
    options: NPAManageEntityOptions<TEntity>,
  ): Promise<void> {
    this.assertWritable("remove");
    return this.removeCascade(entity, options, new Set());
  }

  findManagedById<TEntity extends object>(
    id: unknown,
    options: NPAManageEntityOptions<TEntity>,
  ): TEntity | undefined {
    const metadata = getEntityMetadata(options.entity);
    return this.findByIdentity(options.adapter, metadata.target, id)?.entity as
      | TEntity
      | undefined;
  }

  manageMany<TEntity extends object>(
    entities: TEntity[],
    options: NPAManageEntityOptions<TEntity>,
  ): TEntity[] {
    return entities.map((entity) => this.manage(entity, options));
  }

  detach(entity: object | null | undefined): void {
    if (entity) {
      this.detachManagedEntity(entity);
    }
  }

  detachById<TEntity extends object>(
    id: unknown,
    options: NPAManageEntityOptions<TEntity>,
  ): void {
    const metadata = getEntityMetadata(options.entity);

    for (const [entity, managed] of this.managed.entries()) {
      if (!isSameManagedEntity(managed, metadata, options.adapter)) {
        continue;
      }

      if (isSameId(readEntityPrimaryValue(managed.entity, metadata), id)) {
        this.detachManagedEntity(entity);
      }
    }
  }

  detachAll<TEntity extends object>(
    options?: NPAManageEntityOptions<TEntity>,
  ): void {
    if (!options) {
      this.clear();
      return;
    }

    const metadata = getEntityMetadata(options.entity);

    for (const [entity, managed] of this.managed.entries()) {
      if (isSameManagedEntity(managed, metadata, options.adapter)) {
        this.detachManagedEntity(entity);
      }
    }
  }

  clear(): void {
    this.managed.clear();
    this.newEntities.clear();
    this.removedEntities.clear();
    this.identityMap = new WeakMap();
  }

  async flush(): Promise<void> {
    if (this.options.readOnly) {
      this.assertNoPendingChangesForReadOnlyFlush();
      return;
    }

    await this.flushNewEntities();

    for (const managed of [...this.managed.values()]) {
      if (this.newEntities.has(managed.entity) || this.removedEntities.has(managed.entity)) {
        continue;
      }

      const patch = diffEntity(managed.entity, managed.snapshot, managed.metadata);
      const hasManyToManyChanges = hasLoadedManyToManyChanges(managed);
      const hasOneToManyChanges = hasLoadedOneToManyChanges(managed);

      if (
        Object.keys(patch).length === 0 &&
        !hasOneToManyChanges &&
        !hasManyToManyChanges
      ) {
        continue;
      }

      const id = readEntityPrimaryValue(managed.entity, managed.metadata);

      if (!hasCompletePrimaryValue(id)) {
        throw new NPAPersistenceError(
          `Cannot flush dirty entity "${managed.metadata.target.name}" without a primary key value.`,
          {
            code: "NPA_PRIMARY_KEY_REQUIRED",
            details: { entityName: managed.metadata.target.name },
          },
        );
      }

      if (Object.keys(patch).length > 0) {
        const versionColumn = managed.metadata.versionColumn;
        const expectedVersion = versionColumn
          ? managed.snapshot.get(versionColumn.propertyName)
          : undefined;

        if (versionColumn && (expectedVersion === null || expectedVersion === undefined)) {
          throw new NPAPersistenceError(
            `Cannot flush versioned entity "${managed.metadata.target.name}" without a version value.`,
            {
              code: "NPA_VERSION_VALUE_REQUIRED",
              details: { entityName: managed.metadata.target.name },
            },
          );
        }

        const updated = await managed.adapter.updateDirty(managed.entity, id, patch, {
          expectedVersion,
          versionColumn,
        });

        if (!updated && versionColumn) {
          throw new OptimisticLockError(
            managed.metadata.target.name,
            id,
            expectedVersion,
          );
        }

        if (updated && versionColumn) {
          writeColumnValue(
            managed.entity,
            versionColumn,
            readColumnValue(updated, versionColumn),
          );
        }

        if (updated && managed.metadata.updatedAtColumn) {
          const updatedAt = readColumnValue(updated, managed.metadata.updatedAtColumn);

          if (updatedAt !== undefined) {
            writeColumnValue(
              managed.entity,
              managed.metadata.updatedAtColumn,
              updatedAt,
            );
          }
        }
      }

      await this.flushOneToManyChanges(managed);
      await this.flushManyToManyChanges(managed);
      managed.snapshot = snapshotEntity(managed.entity, managed.metadata);
    }

    await this.flushRemovedEntities();
  }

  private assertWritable(operation: string): void {
    if (this.options.readOnly) {
      throw new NPAPersistenceError(`Cannot ${operation} inside a read-only transaction.`, {
        code: "NPA_READ_ONLY_TRANSACTION_WRITE",
        details: { operation },
      });
    }
  }

  private assertNoPendingChangesForReadOnlyFlush(): void {
    if (this.newEntities.size > 0) {
      throw new NPAPersistenceError("Cannot flush persisted entities inside a read-only transaction.", {
        code: "NPA_READ_ONLY_TRANSACTION_WRITE",
      });
    }

    if (this.removedEntities.size > 0) {
      throw new NPAPersistenceError("Cannot flush removed entities inside a read-only transaction.", {
        code: "NPA_READ_ONLY_TRANSACTION_WRITE",
      });
    }

    for (const managed of this.managed.values()) {
      const patch = diffEntity(managed.entity, managed.snapshot, managed.metadata);
      const hasManyToManyChanges = hasLoadedManyToManyChanges(managed);
      const hasOneToManyChanges = hasLoadedOneToManyChanges(managed);

      if (
        Object.keys(patch).length > 0 ||
        hasManyToManyChanges ||
        hasOneToManyChanges
      ) {
        throw new NPAPersistenceError(
          `Cannot flush dirty entity "${managed.metadata.target.name}" inside a read-only transaction.`,
          {
            code: "NPA_READ_ONLY_TRANSACTION_WRITE",
            details: { entityName: managed.metadata.target.name },
          },
        );
      }
    }
  }

  private async persistCascade<TEntity extends object>(
    entity: TEntity,
    options: NPAManageEntityOptions<TEntity>,
    seen: Set<object>,
  ): Promise<TEntity> {
    if (seen.has(entity)) {
      return entity;
    }

    seen.add(entity);

    const existing = this.findExistingManaged(entity, options);
    const managedEntity = this.manage(entity, options);
    const managed = this.managed.get(managedEntity);

    if (!managed) {
      return managedEntity;
    }

    this.removedEntities.delete(managed.entity);

    if (!existing || this.newEntities.has(managed.entity)) {
      this.newEntities.add(managed.entity);
    }

    for (const relation of managed.metadata.relations) {
      if (!hasCascade(relation, CascadeType.PERSIST)) {
        continue;
      }

      const relatedEntities = await readCascadeRelationEntities(managed.entity, relation);

      if (relatedEntities.length === 0) {
        continue;
      }

      const adapter = adapterForRelation(managed.adapter, relation, CascadeType.PERSIST);

      for (const related of relatedEntities) {
        if (relation.kind === RelationKind.ONE_TO_MANY && relation.mappedBy) {
          writeRawValue(related, relation.mappedBy, managed.entity);
        }

        await this.persistCascade(related, {
          adapter,
          entity: relation.target(),
        }, seen);
      }
    }

    return managedEntity;
  }

  private async removeCascade<TEntity extends object>(
    entity: TEntity,
    options: NPAManageEntityOptions<TEntity>,
    seen: Set<object>,
  ): Promise<void> {
    if (seen.has(entity)) {
      return;
    }

    seen.add(entity);

    const managedEntity = this.manage(entity, options);
    const managed = this.managed.get(managedEntity);

    if (!managed) {
      return;
    }

    await this.removeCascadeRelations(
      managed,
      [RelationKind.ONE_TO_MANY, RelationKind.MANY_TO_MANY, RelationKind.ONE_TO_ONE],
      seen,
      (relation) => relation.kind !== RelationKind.ONE_TO_ONE || Boolean(relation.mappedBy),
    );

    if (this.newEntities.delete(managed.entity)) {
      this.detachManagedEntity(managed.entity);
      return;
    }

    this.removedEntities.add(managed.entity);
    await this.removeCascadeRelations(
      managed,
      [RelationKind.MANY_TO_ONE, RelationKind.ONE_TO_ONE],
      seen,
      (relation) => relation.kind !== RelationKind.ONE_TO_ONE || !relation.mappedBy,
    );
  }

  private async removeCascadeRelations(
    managed: ManagedEntity,
    kinds: RelationKind[],
    seen: Set<object>,
    filter: (relation: RelationMetadata) => boolean = () => true,
  ): Promise<void> {
    for (const relation of managed.metadata.relations) {
      const shouldCascadeRemove = hasCascade(relation, CascadeType.REMOVE) ||
        ((relation.kind === RelationKind.ONE_TO_MANY ||
          relation.kind === RelationKind.ONE_TO_ONE) && relation.orphanRemoval);

      if (!kinds.includes(relation.kind) || !filter(relation) || !shouldCascadeRemove) {
        continue;
      }

      const relatedEntities = await readCascadeRelationEntities(managed.entity, relation);

      if (relatedEntities.length === 0) {
        continue;
      }

      const adapter = adapterForRelation(managed.adapter, relation, CascadeType.REMOVE);

      for (const related of relatedEntities) {
        await this.removeCascade(related, {
          adapter,
          entity: relation.target(),
        }, seen);
      }
    }
  }

  private async flushNewEntities(): Promise<void> {
    const inserted: ManagedEntity[] = [];

    while (this.newEntities.size > 0) {
      let flushed = false;

      for (const entity of [...this.newEntities]) {
        const managed = this.managed.get(entity);

        if (!managed) {
          this.newEntities.delete(entity);
          continue;
        }

        if (this.removedEntities.has(entity)) {
          this.newEntities.delete(entity);
          continue;
        }

        if (!canInsertNow(managed, this.newEntities)) {
          continue;
        }

        await this.insertManagedEntity(managed);
        this.newEntities.delete(entity);
        inserted.push(managed);
        flushed = true;
      }

      if (!flushed) {
        throw new NPAPersistenceError("Cannot flush persisted entity graph with unresolved to-one dependencies.", {
          code: "NPA_UNRESOLVED_TO_ONE_DEPENDENCY",
        });
      }
    }

    for (const managed of inserted) {
      await this.flushOneToManyChanges(managed, { force: true });
      await this.flushManyToManyChanges(managed, { force: true });
      managed.snapshot = snapshotEntity(managed.entity, managed.metadata);
    }
  }

  private async insertManagedEntity(managed: ManagedEntity): Promise<void> {
    if (!managed.adapter.insertManaged) {
      throw new NPAPersistenceError(
        `Entity "${managed.metadata.target.name}" cannot be persisted because its adapter does not support persist.`,
        {
          code: "NPA_PERSIST_UNSUPPORTED",
          details: { entityName: managed.metadata.target.name },
        },
      );
    }

    const inserted = await managed.adapter.insertManaged(managed.entity);
    mergeDatabaseValues(managed.entity, inserted, managed.metadata);
    installColumnAliases(managed.entity, managed.metadata);

    this.rememberIdentity(
      managed.adapter,
      managed.metadata.target,
      readEntityPrimaryValue(managed.entity, managed.metadata),
      managed,
    );
  }

  private async flushRemovedEntities(): Promise<void> {
    for (const entity of [...this.removedEntities]) {
      const managed = this.managed.get(entity);

      if (!managed) {
        this.removedEntities.delete(entity);
        continue;
      }

      if (!managed.adapter.deleteManaged) {
        throw new NPAPersistenceError(
          `Entity "${managed.metadata.target.name}" cannot be removed because its adapter does not support remove.`,
          {
            code: "NPA_REMOVE_UNSUPPORTED",
            details: { entityName: managed.metadata.target.name },
          },
        );
      }

      const id = readEntityPrimaryValue(managed.entity, managed.metadata);

      if (!hasCompletePrimaryValue(id)) {
        throw new NPAPersistenceError(
          `Cannot remove entity "${managed.metadata.target.name}" without a primary key value.`,
          {
            code: "NPA_PRIMARY_KEY_REQUIRED",
            details: { entityName: managed.metadata.target.name },
          },
        );
      }

      await this.deleteManyToManyRelations(managed, id);
      await managed.adapter.deleteManaged(managed.entity, id);
      this.removedEntities.delete(entity);
      this.detachManagedEntity(entity);
    }
  }

  private async flushManyToManyChanges(
    managed: ManagedEntity,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const id = readEntityPrimaryValue(managed.entity, managed.metadata);

    if (!hasCompletePrimaryValue(id)) {
      throw new NPAPersistenceError(
        `Cannot flush many-to-many relations for "${managed.metadata.target.name}" without a primary key value.`,
        {
          code: "NPA_PRIMARY_KEY_REQUIRED",
          details: { entityName: managed.metadata.target.name },
        },
      );
    }

    for (const relation of managed.metadata.relations) {
      if (relation.kind !== RelationKind.MANY_TO_MANY) {
        continue;
      }

      const targetIds = readManyToManyRelationIds(managed.entity, relation);

      if (!targetIds) {
        continue;
      }

      const previousIds = managed.snapshot.get(relation.propertyName);

      if (!options.force && isSameIdSet(targetIds, previousIds)) {
        continue;
      }

      if (!managed.adapter.syncManyToManyRelations) {
        throw new NPAPersistenceError(
          `Entity "${managed.metadata.target.name}" cannot flush relation "${relation.propertyName}" because its adapter does not support many-to-many sync.`,
          {
            code: "NPA_RELATION_SYNC_UNSUPPORTED",
            details: {
              entityName: managed.metadata.target.name,
              relation: relation.propertyName,
            },
          },
        );
      }

      await managed.adapter.syncManyToManyRelations(
        managed.entity,
        id,
        relation,
        targetIds,
      );
    }
  }

  private async flushOneToManyChanges(
    managed: ManagedEntity,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const id = readEntityPrimaryValue(managed.entity, managed.metadata);

    if (!hasCompletePrimaryValue(id)) {
      throw new NPAPersistenceError(
        `Cannot flush one-to-many relations for "${managed.metadata.target.name}" without a primary key value.`,
        {
          code: "NPA_PRIMARY_KEY_REQUIRED",
          details: { entityName: managed.metadata.target.name },
        },
      );
    }

    for (const relation of managed.metadata.relations) {
      if (relation.kind !== RelationKind.ONE_TO_MANY) {
        continue;
      }

      const currentIds = readToManyRelationIds(managed.entity, relation);

      if (!currentIds) {
        continue;
      }

      const previousSnapshot = managed.snapshot.get(relation.propertyName);
      const previousIds = toManySnapshotIds(previousSnapshot);

      if (!options.force && isSameIdSet(currentIds, previousIds)) {
        continue;
      }

      const targetRelation = findMappedByManyToOneRelation(managed.metadata, relation);
      const targetAdapter = adapterForRelation(managed.adapter, relation, CascadeType.PERSIST);
      const currentSet = new Set(currentIds.map(idKey));
      const previousSet = previousIds ?? [];

      for (const targetId of currentIds) {
        if (!options.force && previousSet.some((value) => isSameId(value, targetId))) {
          continue;
        }

        await targetAdapter.updateDirty(
          {} as object,
          targetId,
          { [targetRelation.propertyName]: managed.entity },
        );
      }

      for (const targetId of previousSet) {
        if (currentSet.has(idKey(targetId))) {
          continue;
        }

        if (relation.orphanRemoval) {
          await this.removeCascade(
            readSnapshotEntity(previousSnapshot, targetId, relation),
            {
              adapter: targetAdapter,
              entity: relation.target(),
            },
            new Set(),
          );
          continue;
        }

        await targetAdapter.updateDirty(
          {} as object,
          targetId,
          { [targetRelation.propertyName]: null },
        );
      }
    }
  }

  private async deleteManyToManyRelations(
    managed: ManagedEntity,
    id: unknown,
  ): Promise<void> {
    for (const relation of managed.metadata.relations) {
      if (relation.kind !== RelationKind.MANY_TO_MANY) {
        continue;
      }

      if (!managed.adapter.deleteManyToManyRelations) {
        throw new NPAPersistenceError(
          `Entity "${managed.metadata.target.name}" cannot remove relation "${relation.propertyName}" because its adapter does not support many-to-many cleanup.`,
          {
            code: "NPA_RELATION_SYNC_UNSUPPORTED",
            details: {
              entityName: managed.metadata.target.name,
              relation: relation.propertyName,
            },
          },
        );
      }

      await managed.adapter.deleteManyToManyRelations(
        managed.entity,
        id,
        relation,
      );
    }
  }

  private findExistingManaged<TEntity extends object>(
    entity: TEntity,
    options: NPAManageEntityOptions<TEntity>,
  ): ManagedEntity | undefined {
    const managed = this.managed.get(entity);

    if (managed) {
      return managed;
    }

    const metadata = getEntityMetadata(options.entity);
    const id = readEntityPrimaryValue(entity, metadata);

    return !hasCompletePrimaryValue(id)
      ? undefined
      : this.findByIdentity(options.adapter, metadata.target, id);
  }

  private findByIdentity(
    adapter: NPADirtyCheckAdapter,
    entity: object,
    id: unknown,
  ): ManagedEntity | undefined {
    return this.identityMap.get(adapter)?.get(entity)?.get(idKey(id));
  }

  private rememberIdentity(
    adapter: NPADirtyCheckAdapter,
    entity: object,
    id: unknown,
    managed: ManagedEntity,
  ): void {
    if (!hasCompletePrimaryValue(id)) {
      return;
    }

    let entityMap = this.identityMap.get(adapter);

    if (!entityMap) {
      entityMap = new WeakMap();
      this.identityMap.set(adapter, entityMap);
    }

    let idMap = entityMap.get(entity);

    if (!idMap) {
      idMap = new Map();
      entityMap.set(entity, idMap);
    }

    idMap.set(idKey(id), managed);
  }

  private detachManagedEntity(entity: object): void {
    const managed = this.managed.get(entity);

    if (!managed) {
      return;
    }

    const id = readEntityPrimaryValue(managed.entity, managed.metadata);
    this.identityMap.get(managed.adapter)?.get(managed.metadata.target)?.delete(idKey(id));
    this.newEntities.delete(entity);
    this.removedEntities.delete(entity);
    this.managed.delete(entity);
  }
}

function hasCascade(
  relation: RelationMetadata,
  cascade: CascadeType,
): boolean {
  return relation.cascade.includes(cascade);
}

function adapterForRelation<TEntity extends object>(
  adapter: NPADirtyCheckAdapter,
  relation: RelationMetadata,
  cascade: CascadeType,
): NPADirtyCheckAdapter<TEntity> {
  const target = relation.target() as EntityTarget<TEntity>;
  const relatedAdapter = adapter.forEntity?.(target);

  if (!relatedAdapter) {
    throw new NPAPersistenceError(
      `Cascade ${cascade} on relation "${relation.propertyName}" requires an adapter for ${target.name}.`,
      {
        code: "NPA_PERSIST_UNSUPPORTED",
        details: {
          cascade,
          relation: relation.propertyName,
          targetName: target.name,
        },
      },
    );
  }

  return relatedAdapter;
}

async function readCascadeRelationEntities(
  entity: object,
  relation: RelationMetadata,
): Promise<object[]> {
  const property = readOwnProperty(entity, relation.propertyName);

  if (!property.found) {
    return [];
  }

  const value = isPromiseLike(property.value)
    ? await property.value
    : property.value;

  if (isPromiseLike(property.value)) {
    writeRawValue(entity, relation.propertyName, value);
  }

  if (Array.isArray(value)) {
    return value.filter(isObject);
  }

  return isObject(value) ? [value] : [];
}

function canInsertNow(
  managed: ManagedEntity,
  newEntities: Set<object>,
): boolean {
  for (const relation of managed.metadata.relations) {
    if (!isOwningToOneRelation(relation)) {
      continue;
    }

    const property = readOwnDataProperty(managed.entity, relation.propertyName);

    if (!property.found || !isObject(property.value)) {
      continue;
    }

    const related = property.value;

    if (newEntities.has(related)) {
      return false;
    }
  }

  return true;
}

function hasLoadedManyToManyChanges(managed: ManagedEntity): boolean {
  return managed.metadata.relations.some((relation) => {
    if (relation.kind !== RelationKind.MANY_TO_MANY) {
      return false;
    }

    const currentIds = readManyToManyRelationIds(managed.entity, relation);
    return currentIds !== undefined &&
      !isSameIdSet(currentIds, managed.snapshot.get(relation.propertyName));
  });
}

function hasLoadedOneToManyChanges(managed: ManagedEntity): boolean {
  return managed.metadata.relations.some((relation) => {
    if (relation.kind !== RelationKind.ONE_TO_MANY) {
      return false;
    }

    const currentIds = readToManyRelationIds(managed.entity, relation);
    return currentIds !== undefined &&
      !isSameIdSet(currentIds, managed.snapshot.get(relation.propertyName));
  });
}

function diffEntity<TEntity extends object>(
  entity: TEntity,
  snapshot: EntitySnapshot,
  metadata: EntityMetadata,
): Partial<TEntity> {
  const patch = {} as Partial<TEntity>;
  const patchRecord = patch as Record<string, unknown>;

  for (const column of metadata.columns) {
    if (column.primary || column.version) {
      continue;
    }

    const currentValue = readColumnValue(entity, column);

    if (currentValue === undefined) {
      continue;
    }

    if (!isSameValue(currentValue, snapshot.get(column.propertyName))) {
      patchRecord[column.propertyName] = currentValue;
    }
  }

  for (const relation of metadata.relations) {
    if (!isOwningToOneRelation(relation)) {
      continue;
    }

    const currentValue = readRelationForeignKey(entity, relation);

    if (currentValue === undefined) {
      continue;
    }

    if (!isSameId(currentValue, snapshot.get(relation.propertyName))) {
      patchRecord[relation.propertyName] = currentValue;
    }
  }

  return patch;
}

function snapshotEntity(
  entity: object,
  metadata: EntityMetadata,
): EntitySnapshot {
  return new Map([
    ...metadata.columns.map((column) => [
      column.propertyName,
      snapshotValue(readColumnValue(entity, column)),
    ] as const),
    ...metadata.relations
      .filter(isOwningToOneRelation)
      .map((relation) => [
        relation.propertyName,
        snapshotValue(readRelationForeignKeyForSnapshot(entity, relation)),
      ] as const),
    ...metadata.relations
      .filter((relation) => relation.kind === RelationKind.ONE_TO_MANY)
      .map((relation) => [
        relation.propertyName,
        readToManyRelationSnapshotForSnapshot(entity, relation),
      ] as const),
    ...metadata.relations
      .filter((relation) => relation.kind === RelationKind.MANY_TO_MANY)
      .map((relation) => [
        relation.propertyName,
        readManyToManyRelationIdsForSnapshot(entity, relation),
      ] as const),
  ]);
}

function mergeManagedEntity<TEntity extends object>(
  managed: ManagedEntity<TEntity>,
  incoming: TEntity,
): void {
  const wasDirty =
    Object.keys(diffEntity(managed.entity, managed.snapshot, managed.metadata))
      .length > 0;

  mergeLoadedRelations(managed.entity, incoming, managed.metadata);

  if (wasDirty) {
    return;
  }

  mergeDatabaseValues(managed.entity, incoming, managed.metadata);
  managed.snapshot = snapshotEntity(managed.entity, managed.metadata);
}

function mergeDatabaseValues(
  target: object,
  source: object,
  metadata: EntityMetadata,
): void {
  for (const column of metadata.columns) {
    const value = readColumnValue(source, column);

    if (value !== undefined) {
      writeColumnValue(target, column, value);
    }
  }

  for (const relation of metadata.relations) {
    if (!isOwningToOneRelation(relation)) {
      continue;
    }

    const value = readRelationForeignKey(source, relation);

    if (value !== undefined) {
      writeRelationForeignKey(target, relation, value);
    }
  }
}

function mergeLoadedRelations(
  target: object,
  source: object,
  metadata: EntityMetadata,
): void {
  for (const relation of metadata.relations) {
    const property = readOwnDataProperty(source, relation.propertyName);

    if (!property.found) {
      continue;
    }

    writeRawValue(target, relation.propertyName, property.value);
  }
}

function readRelationForeignKey(
  entity: object,
  relation: RelationMetadata,
): unknown {
  const property = readOwnDataProperty(entity, relation.propertyName);

  if (property.found) {
    return readRelationForeignKeyValue(property.value, relation);
  }

  const joinColumns = relationJoinColumns(relation);

  if (joinColumns.length === 1) {
    return readPropertyValue(entity, joinColumns[0].joinColumnName);
  }

  const entries = joinColumns.map(({ column, joinColumnName }) => [
    column.propertyName,
    readPropertyValue(entity, joinColumnName),
  ] as const);

  return entries.some(([, value]) => value === undefined)
    ? undefined
    : Object.fromEntries(entries);
}

function writeRelationForeignKey(
  entity: object,
  relation: RelationMetadata,
  value: unknown,
): void {
  const joinColumns = relationJoinColumns(relation);

  if (joinColumns.length === 1) {
    writeRawValue(entity, joinColumns[0].joinColumnName, value);
    return;
  }

  const record = isObject(value) ? value as Record<string, unknown> : {};

  for (const { column, joinColumnName } of joinColumns) {
    const part = column.propertyName in record
      ? record[column.propertyName]
      : record[column.columnName];
    writeRawValue(entity, joinColumnName, part);
  }
}

function readRelationForeignKeyForSnapshot(
  entity: object,
  relation: RelationMetadata,
): unknown {
  try {
    return readRelationForeignKey(entity, relation);
  } catch {
    return undefined;
  }
}

function readManyToManyRelationIds(
  entity: object,
  relation: RelationMetadata,
): unknown[] | undefined {
  return readToManyRelationIds(entity, relation);
}

function readToManyRelationIds(
  entity: object,
  relation: RelationMetadata,
): unknown[] | undefined {
  return readToManyRelationSnapshot(entity, relation)?.ids;
}

function readToManyRelationSnapshot(
  entity: object,
  relation: RelationMetadata,
): ToManySnapshot | undefined {
  const property = readOwnDataProperty(entity, relation.propertyName);

  if (!property.found || isPromiseLike(property.value)) {
    return undefined;
  }

  if (!Array.isArray(property.value)) {
    throw new NPAPersistenceError(`To-many relation "${relation.propertyName}" must be an array.`, {
      code: "NPA_TO_MANY_RELATION_ARRAY_REQUIRED",
      details: { relation: relation.propertyName },
    });
  }

  const targetMetadata = getEntityMetadata(relation.target());
  const entities = property.value.filter(isObject);

  return {
    ids: uniqueValues(
      entities.map((target) =>
        readRequiredRelationTargetId(target, targetMetadata, relation),
      ),
    ),
    entities,
  };
}

function readRequiredRelationTargetId(
  target: object,
  targetMetadata: EntityMetadata,
  relation: RelationMetadata,
): unknown {
  const id = readEntityPrimaryValue(target, targetMetadata);

  if (!hasCompletePrimaryValue(id)) {
    throw new NPAPersistenceError(
      `Relation "${relation.propertyName}" requires ${targetMetadata.target.name} id.`,
      {
        code: "NPA_RELATION_TARGET_ID_REQUIRED",
        details: {
          relation: relation.propertyName,
          targetName: targetMetadata.target.name,
        },
      },
    );
  }

  return id;
}

function readManyToManyRelationIdsForSnapshot(
  entity: object,
  relation: RelationMetadata,
): unknown[] | undefined {
  return readToManyRelationIdsForSnapshot(entity, relation);
}

function readToManyRelationIdsForSnapshot(
  entity: object,
  relation: RelationMetadata,
): unknown[] | undefined {
  try {
    return readToManyRelationIds(entity, relation);
  } catch {
    return undefined;
  }
}

function readToManyRelationSnapshotForSnapshot(
  entity: object,
  relation: RelationMetadata,
): ToManySnapshot | undefined {
  try {
    return readToManyRelationSnapshot(entity, relation);
  } catch {
    return undefined;
  }
}

function toManySnapshotIds(snapshot: unknown): unknown[] | undefined {
  if (Array.isArray(snapshot)) {
    return snapshot;
  }

  return isToManySnapshot(snapshot) ? snapshot.ids : undefined;
}

function readSnapshotEntity(
  snapshot: unknown,
  id: unknown,
  relation: RelationMetadata,
): object {
  const targetMetadata = getEntityMetadata(relation.target());
  const entity = isToManySnapshot(snapshot)
    ? snapshot.entities.find((candidate) =>
      isSameId(readEntityPrimaryValue(candidate, targetMetadata), id),
    )
    : undefined;

  return entity ?? createEntityReference(targetMetadata, id);
}

function createEntityReference(
  metadata: EntityMetadata,
  id: unknown,
): object {
  const primaryColumns = requirePrimaryColumns(metadata);

  if (primaryColumns.length === 1) {
    const primaryColumn = primaryColumns[0];
    return {
      [primaryColumn.columnName]: id,
      [primaryColumn.propertyName]: id,
    };
  }

  const record = isObject(id) ? id as Record<string, unknown> : {};
  return Object.fromEntries(primaryColumns.flatMap((primaryColumn) => {
    const value = primaryColumn.propertyName in record
      ? record[primaryColumn.propertyName]
      : record[primaryColumn.columnName];

    return [
      [primaryColumn.columnName, value],
      [primaryColumn.propertyName, value],
    ];
  }));
}

function isToManySnapshot(value: unknown): value is ToManySnapshot {
  return isObject(value) &&
    Array.isArray((value as ToManySnapshot).ids) &&
    Array.isArray((value as ToManySnapshot).entities);
}

function findMappedByManyToOneRelation(
  source: EntityMetadata,
  relation: RelationMetadata,
): RelationMetadata {
  if (!relation.mappedBy) {
    throw new NPAMetadataError(`@OneToMany ${source.target.name}.${relation.propertyName} requires mappedBy.`, {
      code: "NPA_RELATION_MAPPED_BY_REQUIRED",
      details: {
        entityName: source.target.name,
        relation: relation.propertyName,
      },
    });
  }

  const targetMetadata = getEntityMetadata(relation.target());
  const targetRelation = targetMetadata.relations.find((candidate) =>
    candidate.kind === RelationKind.MANY_TO_ONE &&
    candidate.propertyName === relation.mappedBy,
  );

  if (!targetRelation) {
    throw new NPAMetadataError(`@OneToMany ${source.target.name}.${relation.propertyName} mappedBy relation was not found.`, {
      code: "NPA_RELATION_MAPPED_BY_NOT_FOUND",
      details: {
        entityName: source.target.name,
        relation: relation.propertyName,
        mappedBy: relation.mappedBy,
      },
    });
  }

  return targetRelation;
}

function isOwningToOneRelation(relation: RelationMetadata): boolean {
  return relation.kind === RelationKind.MANY_TO_ONE ||
    (relation.kind === RelationKind.ONE_TO_ONE && !relation.mappedBy);
}

function isSameIdSet(
  current: unknown[],
  snapshot: unknown,
): boolean {
  const snapshotIds = toManySnapshotIds(snapshot);

  if (!snapshotIds || current.length !== snapshotIds.length) {
    return false;
  }

  return current.every((value) =>
    snapshotIds.some((snapshotValue) => isSameId(value, snapshotValue)),
  );
}

function uniqueValues(values: unknown[]): unknown[] {
  const unique: unknown[] = [];

  for (const value of values) {
    if (!unique.some((current) => isSameId(current, value))) {
      unique.push(value);
    }
  }

  return unique;
}

function readOwnDataProperty(
  entity: object,
  propertyName: string,
): { found: true; value: unknown } | { found: false } {
  const descriptor = Object.getOwnPropertyDescriptor(entity, propertyName);

  if (!descriptor || !("value" in descriptor)) {
    return { found: false };
  }

  return { found: true, value: descriptor.value };
}

function readOwnProperty(
  entity: object,
  propertyName: string,
): { found: true; value: unknown } | { found: false } {
  if (!Object.prototype.hasOwnProperty.call(entity, propertyName)) {
    return { found: false };
  }

  return {
    found: true,
    value: (entity as Record<string, unknown>)[propertyName],
  };
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return isObject(value) && typeof (value as { then?: unknown }).then === "function";
}

function readPropertyValue(entity: object, propertyName: string): unknown {
  return (entity as Record<string, unknown>)[propertyName];
}

function readColumnValue(entity: object, column: ColumnMetadata): unknown {
  const record = entity as Record<string, unknown>;

  if (column.propertyName in record) {
    return record[column.propertyName];
  }

  return record[column.columnName];
}

function writeColumnValue(
  entity: object,
  column: ColumnMetadata,
  value: unknown,
): void {
  const record = entity as Record<string, unknown>;

  if (column.propertyName in record) {
    record[column.propertyName] = value;
    return;
  }

  record[column.columnName] = value;
}

function writeRawValue(
  entity: object,
  propertyName: string,
  value: unknown,
): void {
  (entity as Record<string, unknown>)[propertyName] = value;
}

function installColumnAliases(
  entity: object,
  metadata: EntityMetadata,
): void {
  const record = entity as Record<string, unknown>;

  for (const column of metadata.columns) {
    if (column.propertyName === column.columnName) {
      continue;
    }

    if (column.propertyName in record || !(column.columnName in record)) {
      continue;
    }

    Object.defineProperty(entity, column.propertyName, {
      configurable: true,
      enumerable: false,
      get() {
        return (this as Record<string, unknown>)[column.columnName];
      },
      set(value: unknown) {
        (this as Record<string, unknown>)[column.columnName] = value;
      },
    });
  }
}

function requirePrimaryColumns(metadata: EntityMetadata): ColumnMetadata[] {
  const primaryColumns = primaryColumnsOf(metadata);

  if (primaryColumns.length === 0) {
    throw new NPAPersistenceError(
      `Entity "${metadata.target.name}" requires an @Id column for dirty checking.`,
      {
        code: "NPA_ENTITY_ID_REQUIRED",
        details: { entityName: metadata.target.name },
      },
    );
  }

  return primaryColumns;
}

function isSameManagedEntity(
  managed: ManagedEntity,
  metadata: EntityMetadata,
  adapter: NPADirtyCheckAdapter,
): boolean {
  return managed.metadata.target === metadata.target && managed.adapter === adapter;
}

function snapshotValue(value: unknown): unknown {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  return value;
}

function isSameValue(currentValue: unknown, snapshotValue: unknown): boolean {
  if (currentValue instanceof Date && snapshotValue instanceof Date) {
    return currentValue.getTime() === snapshotValue.getTime();
  }

  return Object.is(currentValue, snapshotValue);
}

function hasCompletePrimaryValue(id: unknown): boolean {
  if (id === null || id === undefined) {
    return false;
  }

  if (!isCompositeIdValue(id)) {
    return true;
  }

  return Object.values(id).every((value) => value !== null && value !== undefined);
}

function isSameId(left: unknown, right: unknown): boolean {
  return idKey(left) === idKey(right);
}

function idKey(id: unknown): string {
  if (id instanceof Date) {
    return `date:${id.getTime()}`;
  }

  if (!isCompositeIdValue(id)) {
    return `${typeof id}:${String(id)}`;
  }

  return `object:${JSON.stringify(sortRecord(id))}`;
}

function isCompositeIdValue(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !(value instanceof Date) && !Array.isArray(value);
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, normalizeIdPart(record[key])]),
  );
}

function normalizeIdPart(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}
