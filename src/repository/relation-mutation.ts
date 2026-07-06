import { NPAPersistenceError } from "../error";

export type NPAToManyRelationKeys<TEntity extends object> = {
  [K in keyof TEntity]-?: NonNullable<NPAResolvedRelation<TEntity[K]>> extends readonly object[]
    ? K
    : never;
}[keyof TEntity] & string;

export type NPAToManyRelationItem<TValue> =
  NonNullable<NPAResolvedRelation<TValue>> extends readonly (infer TItem)[]
    ? Extract<TItem, object>
    : never;

export type NPARelationMutations<TEntity extends object> = {
  [K in NPAToManyRelationKeys<TEntity>]: NPARelationCollection<
    NPAToManyRelationItem<TEntity[K]>
  >;
};

export interface NPARelationCollection<TItem extends object> {
  add(item: TItem): Promise<void>;
  remove(item: TItem): Promise<void>;
  set(items: readonly TItem[]): Promise<void>;
}

type NPAResolvedRelation<TValue> =
  TValue extends Promise<infer TResolved>
    ? NPAResolvedRelation<TResolved>
    : TValue;

export function createRelationMutations<TEntity extends object>(
  entity: TEntity,
): NPARelationMutations<TEntity> {
  return new Proxy({} as NPARelationMutations<TEntity>, {
    get(_target, property) {
      if (typeof property !== "string") {
        return undefined;
      }

      return createRelationCollection(entity, property);
    },
  });
}

function createRelationCollection<TItem extends object>(
  entity: object,
  property: string,
): NPARelationCollection<TItem> {
  return {
    async add(item) {
      const items = await readRelationArray<TItem>(entity, property, {
        initialize: true,
      });

      if (!items.includes(item)) {
        items.push(item);
      }
    },
    async remove(item) {
      const items = await readRelationArray<TItem>(entity, property, {
        initialize: true,
      });

      writeRelationValue(entity, property, items.filter((current) => current !== item));
    },
    async set(items) {
      writeRelationValue(entity, property, [...items]);
    },
  };
}

async function readRelationArray<TItem extends object>(
  entity: object,
  property: string,
  options: { initialize: boolean },
): Promise<TItem[]> {
  const value = await readRelationValue(entity, property);

  if (value === undefined && options.initialize) {
    const items: TItem[] = [];
    writeRelationValue(entity, property, items);
    return items;
  }

  if (!Array.isArray(value)) {
    throw new NPAPersistenceError(
      `Relation "${property}" must be an array before it can be mutated.`,
      {
        code: "NPA_TO_MANY_RELATION_ARRAY_REQUIRED",
        details: { relation: property },
      },
    );
  }

  writeRelationValue(entity, property, value);
  return value;
}

function readRelationValue(entity: object, property: string): unknown {
  return (entity as Record<string, unknown>)[property];
}

function writeRelationValue(
  entity: object,
  property: string,
  value: unknown,
): void {
  (entity as Record<string, unknown>)[property] = value;
}
