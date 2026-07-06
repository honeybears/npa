import {
  FetchType,
  getEntityMetadata,
  type EntityTarget,
  type RelationMetadata,
} from "../entity";
import type { NPALoadOptions } from "./types";

interface MutableRelationLoadTree {
  [propertyName: string]: true | MutableRelationLoadTree;
}

export function withEagerRelations<TEntity extends object>(
  entity: EntityTarget<TEntity> | undefined,
  load: NPALoadOptions<TEntity> | undefined,
  path: EntityTarget[] = [],
): NPALoadOptions<TEntity> | undefined {
  if (!entity || load?.relations === true) {
    return load;
  }

  const eagerRelations = eagerRelationTree(entity, path);

  if (Object.keys(eagerRelations).length === 0) {
    return load;
  }

  return {
    ...load,
    relations: mergeRelationTrees(
      relationTreeFrom(load?.relations),
      eagerRelations,
    ) as NPALoadOptions<TEntity>["relations"],
  };
}

function eagerRelationTree(
  entity: EntityTarget,
  path: EntityTarget[],
): MutableRelationLoadTree {
  const nextPath = [...path, entity];
  const relations = getEntityMetadata(entity).relations
    .filter((relation) => relation.fetch === FetchType.EAGER);

  return Object.fromEntries(relations.map((relation) => [
    relation.propertyName,
    eagerNestedTree(relation, nextPath),
  ]));
}

function eagerNestedTree(
  relation: RelationMetadata,
  path: EntityTarget[],
): true | MutableRelationLoadTree {
  const target = relation.target();

  if (path.includes(target)) {
    return true;
  }

  const nested = eagerRelationTree(target, path);
  return Object.keys(nested).length === 0 ? true : nested;
}

function relationTreeFrom(
  relations: NPALoadOptions["relations"] | undefined,
): MutableRelationLoadTree {
  if (!relations || relations === true) {
    return {};
  }

  if (Array.isArray(relations)) {
    return Object.fromEntries(relations.map((relation) => [relation, true]));
  }

  return { ...(relations as unknown as MutableRelationLoadTree) };
}

function mergeRelationTrees(
  left: MutableRelationLoadTree,
  right: MutableRelationLoadTree,
): MutableRelationLoadTree {
  const merged: MutableRelationLoadTree = { ...left };

  for (const [propertyName, rightValue] of Object.entries(right)) {
    const leftValue = merged[propertyName];

    if (isRelationTree(leftValue) && isRelationTree(rightValue)) {
      merged[propertyName] = mergeRelationTrees(leftValue, rightValue);
    } else if (isRelationTree(leftValue)) {
      merged[propertyName] = leftValue;
    } else if (isRelationTree(rightValue)) {
      merged[propertyName] = rightValue;
    } else {
      merged[propertyName] = true;
    }
  }

  return merged;
}

function isRelationTree(value: unknown): value is MutableRelationLoadTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
