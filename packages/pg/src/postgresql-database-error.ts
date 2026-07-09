import {
  NPADatabaseError,
  NPAError,
  type NPAErrorCode,
} from "@node-persistence-api/core/adapter";

export function toPostgresqlDatabaseError(error: unknown): NPADatabaseError {
  if (error instanceof NPADatabaseError) {
    return error;
  }

  const code = postgresqlDatabaseErrorCode(error);

  return new NPADatabaseError(databaseErrorMessage(error), {
    code,
    cause: error,
    details: databaseErrorDetails(error),
  });
}

function postgresqlDatabaseErrorCode(error: unknown): NPAErrorCode {
  switch (readString(error, "code")) {
    case "23505":
      return "NPA_DATABASE_UNIQUE_CONSTRAINT_FAILED";
    case "23503":
      return "NPA_DATABASE_FOREIGN_KEY_CONSTRAINT_FAILED";
    case "23502":
      return "NPA_DATABASE_NOT_NULL_CONSTRAINT_FAILED";
    default:
      return "NPA_DATABASE_QUERY_FAILED";
  }
}

function databaseErrorMessage(error: unknown): string {
  if (error instanceof NPAError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Database query failed.";
}

function databaseErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return {
    driverCode: error.code,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
  };
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
