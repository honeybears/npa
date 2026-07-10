import type { NPADirtyCheckAdapter } from "./types";

export class EntityIdentityMap<TManaged> {
  private entries = new WeakMap<
    NPADirtyCheckAdapter,
    WeakMap<object, Map<string, TManaged>>
  >();

  find(
    adapter: NPADirtyCheckAdapter,
    entity: object,
    id: unknown,
  ): TManaged | undefined {
    if (!hasCompletePrimaryValue(id)) {
      return undefined;
    }

    return this.entries.get(adapter)?.get(entity)?.get(entityIdKey(id));
  }

  remember(
    adapter: NPADirtyCheckAdapter,
    entity: object,
    id: unknown,
    managed: TManaged,
  ): void {
    if (!hasCompletePrimaryValue(id)) {
      return;
    }

    let entityMap = this.entries.get(adapter);

    if (!entityMap) {
      entityMap = new WeakMap();
      this.entries.set(adapter, entityMap);
    }

    let idMap = entityMap.get(entity);

    if (!idMap) {
      idMap = new Map();
      entityMap.set(entity, idMap);
    }

    idMap.set(entityIdKey(id), managed);
  }

  forget(
    adapter: NPADirtyCheckAdapter,
    entity: object,
    id: unknown,
  ): void {
    this.entries.get(adapter)?.get(entity)?.delete(entityIdKey(id));
  }

  clear(): void {
    this.entries = new WeakMap();
  }
}

export function hasCompletePrimaryValue(id: unknown): boolean {
  if (id === null || id === undefined) {
    return false;
  }

  if (!isCompositeIdValue(id)) {
    return true;
  }

  return Object.values(id).every(
    (value) => value !== null && value !== undefined,
  );
}

export function isSameEntityId(left: unknown, right: unknown): boolean {
  return entityIdKey(left) === entityIdKey(right);
}

export function entityIdKey(id: unknown): string {
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

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
