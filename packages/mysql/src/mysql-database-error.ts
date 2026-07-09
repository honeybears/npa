import {
  NPADatabaseError,
  NPAError,
  type NPADatabaseErrorContext,
  type NPAErrorCode,
} from "@node-persistence-api/core/adapter";

export function toMysqlDatabaseError(
  error: unknown,
  context?: NPADatabaseErrorContext,
): NPADatabaseError {
  if (error instanceof NPADatabaseError) {
    return context ? withContext(error, context) : error;
  }

  const code = mysqlDatabaseErrorCode(error);

  return new NPADatabaseError(databaseErrorMessage(error), {
    code,
    cause: error,
    details: {
      ...context,
      ...databaseErrorDetails(error),
    },
  });
}

function withContext(
  error: NPADatabaseError,
  context: NPADatabaseErrorContext,
): NPADatabaseError {
  return new NPADatabaseError(error.message, {
    cause: error.cause,
    code: error.code,
    details: {
      ...context,
      ...error.details,
    },
  });
}

function mysqlDatabaseErrorCode(error: unknown): NPAErrorCode {
  const driverCode = readString(error, "code");
  const errno = readNumber(error, "errno");

  if (driverCode === "ER_DUP_ENTRY" || errno === 1062) {
    return "NPA_DATABASE_UNIQUE_CONSTRAINT_FAILED";
  }

  if (
    driverCode === "ER_NO_REFERENCED_ROW_2" ||
    driverCode === "ER_ROW_IS_REFERENCED_2" ||
    errno === 1451 ||
    errno === 1452
  ) {
    return "NPA_DATABASE_FOREIGN_KEY_CONSTRAINT_FAILED";
  }

  if (driverCode === "ER_BAD_NULL_ERROR" || errno === 1048) {
    return "NPA_DATABASE_NOT_NULL_CONSTRAINT_FAILED";
  }

  return "NPA_DATABASE_QUERY_FAILED";
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
    errno: error.errno,
    sqlState: error.sqlState,
    sqlMessage: error.sqlMessage,
  };
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number"
    ? value[key]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
