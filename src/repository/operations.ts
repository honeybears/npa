import { NPADatabaseError } from "../error";

export type NPAQueryAdapter = "postgresql" | "mysql" | (string & {});

export interface NPAQueryEvent {
  adapter: NPAQueryAdapter;
  text: string;
  values: readonly unknown[];
  durationMs: number;
  success: boolean;
  rowCount?: number;
  affectedRows?: number;
  error?: NPADatabaseError;
}

export type NPAQueryLogger = (event: NPAQueryEvent) => void | Promise<void>;
export type NPAQueryHook = (event: NPAQueryEvent) => void | Promise<void>;

export interface NPAOperationsOptions {
  logger?: NPAQueryLogger;
  slowQueryThresholdMs?: number;
  onSlowQuery?: NPAQueryHook;
}

export interface NPADatabaseErrorContext {
  adapter: NPAQueryAdapter;
  text: string;
  values: readonly unknown[];
}

export type NPADatabaseErrorMapper = (
  error: unknown,
  context: NPADatabaseErrorContext,
) => NPADatabaseError;

export interface NPAQueryOperationOptions<TResult> {
  adapter: NPAQueryAdapter;
  text: string;
  values?: readonly unknown[];
  operations?: NPAOperationsOptions;
  execute: () => Promise<TResult> | TResult;
  resultMetadata?: (result: TResult) => Partial<NPAQueryEvent>;
  toDatabaseError?: NPADatabaseErrorMapper;
}

export async function executeNPAQueryOperation<TResult>(
  options: NPAQueryOperationOptions<TResult>,
): Promise<TResult> {
  const startedAt = now();
  const values = [...(options.values ?? [])];

  try {
    const result = await Promise.resolve(options.execute());
    emitQueryEvent(options.operations, {
      ...options.resultMetadata?.(result),
      adapter: options.adapter,
      durationMs: elapsedSince(startedAt),
      success: true,
      text: options.text,
      values,
    });

    return result;
  } catch (error) {
    const context = {
      adapter: options.adapter,
      text: options.text,
      values,
    };
    const databaseError = options.toDatabaseError
      ? options.toDatabaseError(error, context)
      : toDatabaseError(error, context);

    emitQueryEvent(options.operations, {
      adapter: options.adapter,
      durationMs: elapsedSince(startedAt),
      error: databaseError,
      success: false,
      text: options.text,
      values,
    });

    throw databaseError;
  }
}

function emitQueryEvent(
  operations: NPAOperationsOptions | undefined,
  event: NPAQueryEvent,
): void {
  callHook(operations?.logger, event);

  if (
    operations?.onSlowQuery &&
    operations.slowQueryThresholdMs !== undefined &&
    event.durationMs >= operations.slowQueryThresholdMs
  ) {
    callHook(operations.onSlowQuery, event);
  }
}

function callHook(
  hook: NPAQueryHook | undefined,
  event: NPAQueryEvent,
): void {
  if (!hook) {
    return;
  }

  try {
    void Promise.resolve(hook(event)).catch(() => undefined);
  } catch {
    // Logging hooks must not change repository behavior.
  }
}

function toDatabaseError(
  error: unknown,
  context: NPADatabaseErrorContext,
): NPADatabaseError {
  if (error instanceof NPADatabaseError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new NPADatabaseError(`${context.adapter} query failed: ${message}`, {
    cause: error,
    code: "NPA_DATABASE_QUERY_FAILED",
    details: { ...context },
  });
}

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, now() - startedAt);
}
