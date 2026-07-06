import { NPADatabaseError, type NPAErrorCode } from "../error";

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

export interface NPADatabaseErrorDetails {
  adapter: NPAQueryAdapter;
  text: string;
  values: readonly unknown[];
  cause: unknown;
  code?: string;
  constraint?: string;
  detail?: string;
  errno?: number | string;
  sqlState?: string;
}

export interface NPAQueryOperationOptions<TResult> {
  adapter: NPAQueryAdapter;
  text: string;
  values?: readonly unknown[];
  operations?: NPAOperationsOptions;
  execute: () => Promise<TResult> | TResult;
  resultMetadata?: (result: TResult) => Partial<NPAQueryEvent>;
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
    const databaseError = normalizeDatabaseError(error, {
      adapter: options.adapter,
      text: options.text,
      values,
    });

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

function normalizeDatabaseError(
  error: unknown,
  context: Pick<NPADatabaseErrorDetails, "adapter" | "text" | "values">,
): NPADatabaseError {
  if (error instanceof NPADatabaseError) {
    return error;
  }

  const record = isRecord(error) ? error : {};
  const details: NPADatabaseErrorDetails = {
    ...context,
    cause: error,
    code: readString(record.code),
    constraint: readString(record.constraint),
    detail: readString(record.detail),
    errno: readNumberOrString(record.errno),
    sqlState: readString(record.sqlState) ?? readString(record.sqlstate),
  };

  return new NPADatabaseError(formatDatabaseErrorMessage(details), {
    cause: error,
    code: databaseErrorCode(details),
    details: {
      adapter: details.adapter,
      text: details.text,
      values: details.values,
      driverCode: details.code,
      constraint: details.constraint,
      detail: details.detail,
      errno: details.errno,
      sqlState: details.sqlState,
    },
  });
}

function formatDatabaseErrorMessage(details: NPADatabaseErrorDetails): string {
  const message = details.cause instanceof Error
    ? details.cause.message
    : String(details.cause);
  return `${details.adapter} query failed: ${message}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumberOrString(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string"
    ? value
    : undefined;
}

function databaseErrorCode(details: NPADatabaseErrorDetails): NPAErrorCode {
  if (
    details.code === "23505" ||
    details.code === "ER_DUP_ENTRY" ||
    details.errno === 1062
  ) {
    return "NPA_DATABASE_UNIQUE_CONSTRAINT_FAILED";
  }

  if (
    details.code === "23503" ||
    details.code === "ER_NO_REFERENCED_ROW_2" ||
    details.code === "ER_ROW_IS_REFERENCED_2" ||
    details.errno === 1451 ||
    details.errno === 1452
  ) {
    return "NPA_DATABASE_FOREIGN_KEY_CONSTRAINT_FAILED";
  }

  if (
    details.code === "23502" ||
    details.code === "ER_BAD_NULL_ERROR" ||
    details.errno === 1048
  ) {
    return "NPA_DATABASE_NOT_NULL_CONSTRAINT_FAILED";
  }

  return "NPA_DATABASE_QUERY_FAILED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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
