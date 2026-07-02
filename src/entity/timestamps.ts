import { EntityMetadata, EntityTarget } from "./types";
import { getOptionalEntityMetadata } from "./metadata-storage";

export function withUpdatedAtTimestamp<TEntity extends object>(
  patch: Partial<TEntity>,
  target: EntityTarget<TEntity> | undefined,
  now: Date = new Date(),
  options: { overwrite?: boolean } = {},
): Partial<TEntity> {
  const metadata = getOptionalEntityMetadata(target);
  const updatedAtColumn = metadata?.updatedAtColumn;

  if (!metadata || !updatedAtColumn || !hasUpdatePayload(patch, metadata)) {
    return patch;
  }

  const record = patch as Record<string, unknown>;
  const current = record[updatedAtColumn.propertyName];

  if (!options.overwrite && current !== null && current !== undefined) {
    return patch;
  }

  return {
    ...patch,
    [updatedAtColumn.propertyName]: now,
  };
}

function hasUpdatePayload<TEntity extends object>(
  patch: Partial<TEntity>,
  metadata: EntityMetadata,
): boolean {
  const ignored = new Set([
    metadata.primaryColumn?.propertyName,
    metadata.versionColumn?.propertyName,
    metadata.updatedAtColumn?.propertyName,
  ].filter((value): value is string => value !== undefined));

  return Object.entries(patch).some(
    ([property, value]) => value !== undefined && !ignored.has(property),
  );
}
