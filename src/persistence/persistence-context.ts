import {
  CascadeType,
  ColumnMetadata,
  EntityMetadata,
  EntityTarget,
  getEntityMetadata,
  readEntityPrimaryValue,
  readRelationForeignKeyValue,
  relationJoinColumnName,
  RelationKind,
  RelationMetadata,
} from "../entity";
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
    WeakMap<object, Map<unknown, ManagedEntity>>
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
    const primaryColumn = requirePrimaryColumn(metadata);
    installColumnAliases(entity, metadata);
    const id = readColumnValue(entity, primaryColumn);
    const existing = id === null || id === undefined
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
    const primaryColumn = requirePrimaryColumn(metadata);

    for (const [entity, managed] of this.managed.entries()) {
      if (!isSameManagedEntity(managed, metadata, options.adapter)) {
        continue;
      }

      if (Object.is(readColumnValue(managed.entity, primaryColumn), id)) {
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

      const primaryColumn = requirePrimaryColumn(managed.metadata);
      const id = readColumnValue(managed.entity, primaryColumn);

      if (id === null || id === undefined) {
        throw new Error(
          `Cannot flush dirty entity "${managed.metadata.target.name}" without a primary key value.`,
        );
      }

      if (Object.keys(patch).length > 0) {
        const versionColumn = managed.metadata.versionColumn;
        const expectedVersion = versionColumn
          ? managed.snapshot.get(versionColumn.propertyName)
          : undefined;

        if (versionColumn && (expectedVersion === null || expectedVersion === undefined)) {
          throw new Error(
            `Cannot flush versioned entity "${managed.metadata.target.name}" without a version value.`,
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
      throw new Error(`Cannot ${operation} inside a read-only transaction.`);
    }
  }

  private assertNoPendingChangesForReadOnlyFlush(): void {
    if (this.newEntities.size > 0) {
      throw new Error("Cannot flush persisted entities inside a read-only transaction.");
    }

    if (this.removedEntities.size > 0) {
      throw new Error("Cannot flush removed entities inside a read-only transaction.");
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
        throw new Error(
          `Cannot flush dirty entity "${managed.metadata.target.name}" inside a read-only transaction.`,
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
        throw new Error("Cannot flush persisted entity graph with unresolved to-one dependencies.");
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
      throw new Error(
        `Entity "${managed.metadata.target.name}" cannot be persisted because its adapter does not support persist.`,
      );
    }

    const inserted = await managed.adapter.insertManaged(managed.entity);
    mergeDatabaseValues(managed.entity, inserted, managed.metadata);
    installColumnAliases(managed.entity, managed.metadata);

    const primaryColumn = requirePrimaryColumn(managed.metadata);
    this.rememberIdentity(
      managed.adapter,
      managed.metadata.target,
      readColumnValue(managed.entity, primaryColumn),
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
        throw new Error(
          `Entity "${managed.metadata.target.name}" cannot be removed because its adapter does not support remove.`,
        );
      }

      const primaryColumn = requirePrimaryColumn(managed.metadata);
      const id = readColumnValue(managed.entity, primaryColumn);

      if (id === null || id === undefined) {
        throw new Error(
          `Cannot remove entity "${managed.metadata.target.name}" without a primary key value.`,
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
    const primaryColumn = requirePrimaryColumn(managed.metadata);
    const id = readColumnValue(managed.entity, primaryColumn);

    if (id === null || id === undefined) {
      throw new Error(
        `Cannot flush many-to-many relations for "${managed.metadata.target.name}" without a primary key value.`,
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
        throw new Error(
          `Entity "${managed.metadata.target.name}" cannot flush relation "${relation.propertyName}" because its adapter does not support many-to-many sync.`,
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
    const primaryColumn = requirePrimaryColumn(managed.metadata);
    const id = readColumnValue(managed.entity, primaryColumn);

    if (id === null || id === undefined) {
      throw new Error(
        `Cannot flush one-to-many relations for "${managed.metadata.target.name}" without a primary key value.`,
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
      const currentSet = new Set(currentIds);
      const previousSet = previousIds ?? [];

      for (const targetId of currentIds) {
        if (!options.force && previousSet.some((value) => Object.is(value, targetId))) {
          continue;
        }

        await targetAdapter.updateDirty(
          {} as object,
          targetId,
          { [targetRelation.propertyName]: managed.entity },
        );
      }

      for (const targetId of previousSet) {
        if (currentSet.has(targetId)) {
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
        throw new Error(
          `Entity "${managed.metadata.target.name}" cannot remove relation "${relation.propertyName}" because its adapter does not support many-to-many cleanup.`,
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
    const primaryColumn = requirePrimaryColumn(metadata);
    const id = readColumnValue(entity, primaryColumn);

    return id === null || id === undefined
      ? undefined
      : this.findByIdentity(options.adapter, metadata.target, id);
  }

  private findByIdentity(
    adapter: NPADirtyCheckAdapter,
    entity: object,
    id: unknown,
  ): ManagedEntity | undefined {
    return this.identityMap.get(adapter)?.get(entity)?.get(id);
  }

  private rememberIdentity(
    adapter: NPADirtyCheckAdapter,
    entity: object,
    id: unknown,
    managed: ManagedEntity,
  ): void {
    if (id === null || id === undefined) {
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

    idMap.set(id, managed);
  }

  private detachManagedEntity(entity: object): void {
    const managed = this.managed.get(entity);

    if (!managed) {
      return;
    }

    const primaryColumn = requirePrimaryColumn(managed.metadata);
    const id = readColumnValue(managed.entity, primaryColumn);
    this.identityMap.get(managed.adapter)?.get(managed.metadata.target)?.delete(id);
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
    throw new Error(
      `Cascade ${cascade} on relation "${relation.propertyName}" requires an adapter for ${target.name}.`,
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

    if (!isSameValue(currentValue, snapshot.get(relation.propertyName))) {
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
      writeRawValue(target, relationJoinColumnName(relation), value);
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

  return readPropertyValue(entity, relationJoinColumnName(relation));
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
    throw new Error(`To-many relation "${relation.propertyName}" must be an array.`);
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

  if (id === null || id === undefined) {
    throw new Error(
      `Relation "${relation.propertyName}" requires ${targetMetadata.target.name} id.`,
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
      Object.is(readEntityPrimaryValue(candidate, targetMetadata), id),
    )
    : undefined;

  return entity ?? createEntityReference(targetMetadata, id);
}

function createEntityReference(
  metadata: EntityMetadata,
  id: unknown,
): object {
  const primaryColumn = requirePrimaryColumn(metadata);
  return {
    [primaryColumn.columnName]: id,
    [primaryColumn.propertyName]: id,
  };
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
    throw new Error(`@OneToMany ${source.target.name}.${relation.propertyName} requires mappedBy.`);
  }

  const targetMetadata = getEntityMetadata(relation.target());
  const targetRelation = targetMetadata.relations.find((candidate) =>
    candidate.kind === RelationKind.MANY_TO_ONE &&
    candidate.propertyName === relation.mappedBy,
  );

  if (!targetRelation) {
    throw new Error(`@OneToMany ${source.target.name}.${relation.propertyName} mappedBy relation was not found.`);
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
    snapshotIds.some((snapshotValue) => Object.is(value, snapshotValue)),
  );
}

function uniqueValues(values: unknown[]): unknown[] {
  const unique: unknown[] = [];

  for (const value of values) {
    if (!unique.some((current) => Object.is(current, value))) {
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

function requirePrimaryColumn(metadata: EntityMetadata): ColumnMetadata {
  if (!metadata.primaryColumn) {
    throw new Error(
      `Entity "${metadata.target.name}" requires an @Id column for dirty checking.`,
    );
  }

  return metadata.primaryColumn;
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
