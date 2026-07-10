export type EntitySnapshot = Map<string, unknown>;

export function createEntitySnapshot(
  entries: Iterable<readonly [string, unknown]>,
): EntitySnapshot {
  return new Map(
    Array.from(entries, ([propertyName, value]) => [
      propertyName,
      snapshotValue(value),
    ]),
  );
}

export function snapshotValue(value: unknown): unknown {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  return value;
}

export function isSameSnapshotValue(
  currentValue: unknown,
  snapshotValue: unknown,
): boolean {
  if (currentValue instanceof Date && snapshotValue instanceof Date) {
    return currentValue.getTime() === snapshotValue.getTime();
  }

  return Object.is(currentValue, snapshotValue);
}
