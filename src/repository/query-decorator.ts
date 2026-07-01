export type NPARawQueryResult = "many" | "one" | "scalar" | "execute";

export interface NPARawQueryOptions {
  result?: NPARawQueryResult;
  managed?: boolean;
}

export interface NPARawQueryMetadata {
  text: string;
  result: NPARawQueryResult;
  managed: boolean;
}

const rawQueryMetadata = new WeakMap<
  object,
  Map<PropertyKey, NPARawQueryMetadata>
>();

export function Query(
  text: string,
  options: NPARawQueryOptions = {},
): MethodDecorator & PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("@Query requires a non-empty SQL string.");
    }

    let metadata = rawQueryMetadata.get(target);

    if (!metadata) {
      metadata = new Map();
      rawQueryMetadata.set(target, metadata);
    }

    metadata.set(propertyKey, {
      text,
      result: options.result ?? "many",
      managed: options.managed ?? false,
    });
  };
}

export function getRawQueryMetadata(
  target: object,
  propertyKey: PropertyKey,
): NPARawQueryMetadata | undefined {
  let current: object | null = target;

  while (current) {
    const metadata = rawQueryMetadata.get(current)?.get(propertyKey);

    if (metadata) {
      return metadata;
    }

    current = Object.getPrototypeOf(current);
  }

  return undefined;
}
