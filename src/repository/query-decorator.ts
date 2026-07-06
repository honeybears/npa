import { NPAQueryError } from "../error";

export enum RawQueryResult {
  MANY = "many",
  ONE = "one",
  SCALAR = "scalar",
  EXECUTE = "execute",
}

export interface RawQueryOptions {
  result?: RawQueryResult | `${RawQueryResult}`;
  managed?: boolean;
}

export interface RawQueryMetadata {
  text: string;
  result: RawQueryResult;
  managed: boolean;
}

const rawQueryMetadata = new WeakMap<
  object,
  Map<PropertyKey, RawQueryMetadata>
>();

export function Query(
  text: string,
  options: RawQueryOptions = {},
): MethodDecorator & PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new NPAQueryError("@Query requires a non-empty SQL string.", {
        code: "NPA_INVALID_QUERY_PREDICATE",
        details: { propertyKey: String(propertyKey) },
      });
    }

    let metadata = rawQueryMetadata.get(target);

    if (!metadata) {
      metadata = new Map();
      rawQueryMetadata.set(target, metadata);
    }

    metadata.set(propertyKey, {
      text,
      result: normalizeRawQueryResult(options.result),
      managed: options.managed ?? false,
    });
  };
}

function normalizeRawQueryResult(
  result: RawQueryOptions["result"] = RawQueryResult.MANY,
): RawQueryResult {
  switch (result) {
    case RawQueryResult.MANY:
    case RawQueryResult.ONE:
    case RawQueryResult.SCALAR:
    case RawQueryResult.EXECUTE:
      return result as RawQueryResult;
    default:
      throw new NPAQueryError(`Unsupported @Query result mode: ${String(result)}.`, {
        code: "NPA_RAW_QUERY_RESULT_MODE_UNSUPPORTED",
        details: { result },
      });
  }
}

export function getRawQueryMetadata(
  target: object,
  propertyKey: PropertyKey,
): RawQueryMetadata | undefined {
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
