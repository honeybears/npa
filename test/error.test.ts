import { describe, expect, test } from "@jest/globals";
import {
  NPAConfigurationError,
  NPADatabaseError,
  NPAError,
  NPAMetadataError,
  NPAMigrationError,
  NPAPaginationError,
  NPAPersistenceError,
  NPAQueryError,
  NPATransactionError,
  OptimisticLockError,
  parseQueryMethod,
  RollbackOnlyError,
} from "../src";
import { getEntityMetadata } from "../src/entity/metadata-storage";
import { decodeCursorValues } from "../src/repository/pagination";

describe("NPA error taxonomy", () => {
  test("domain errors share the NPAError base and expose stable codes", () => {
    const errors = [
      new NPAConfigurationError("config", { code: "NPA_INVALID_CONFIG" }),
      new NPAMetadataError("metadata", { code: "NPA_ENTITY_METADATA_NOT_FOUND" }),
      new NPAQueryError("query", { code: "NPA_INVALID_QUERY_METHOD" }),
      new NPAPaginationError("pagination", { code: "NPA_INVALID_CURSOR" }),
      new NPAMigrationError("migration", {
        code: "NPA_MIGRATION_CHECKSUM_MISMATCH",
      }),
      new NPATransactionError("transaction", { code: "NPA_ROLLBACK_ONLY" }),
      new NPAPersistenceError("persistence", {
        code: "NPA_PRIMARY_KEY_REQUIRED",
      }),
      new NPADatabaseError("database", { code: "NPA_DATABASE_QUERY_FAILED" }),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(NPAError);
      expect(error.code).toMatch(/^NPA_/);
    }
  });

  test("invalid cursor throws NPAPaginationError with NPA_INVALID_CURSOR", () => {
    expect(() => decodeCursorValues("not-a-cursor")).toThrow(NPAPaginationError);

    try {
      decodeCursorValues("not-a-cursor");
    } catch (error) {
      expect(error).toBeInstanceOf(NPAError);
      expect(error).toBeInstanceOf(NPAPaginationError);
      expect((error as NPAError).code).toEqual("NPA_INVALID_CURSOR");
    }
  });

  test("invalid query method throws NPAQueryError with NPA_INVALID_QUERY_METHOD", () => {
    expect(() => parseQueryMethod("lookupByName")).toThrow(NPAQueryError);

    try {
      parseQueryMethod("lookupByName");
    } catch (error) {
      expect(error).toBeInstanceOf(NPAError);
      expect(error).toBeInstanceOf(NPAQueryError);
      expect((error as NPAError).code).toEqual("NPA_INVALID_QUERY_METHOD");
    }
  });

  test("missing entity metadata throws NPAMetadataError with NPA_ENTITY_METADATA_NOT_FOUND", () => {
    class UnregisteredEntity {}

    expect(() => getEntityMetadata(UnregisteredEntity)).toThrow(NPAMetadataError);

    try {
      getEntityMetadata(UnregisteredEntity);
    } catch (error) {
      expect(error).toBeInstanceOf(NPAError);
      expect(error).toBeInstanceOf(NPAMetadataError);
      expect((error as NPAError).code).toEqual("NPA_ENTITY_METADATA_NOT_FOUND");
    }
  });

  test("legacy transaction and persistence errors keep import compatibility", () => {
    const rollback = new RollbackOnlyError();
    const optimisticLock = new OptimisticLockError("User", 1, 2);

    expect(rollback).toBeInstanceOf(NPAError);
    expect(rollback).toBeInstanceOf(NPATransactionError);
    expect(rollback.code).toEqual("NPA_ROLLBACK_ONLY");

    expect(optimisticLock).toBeInstanceOf(NPAError);
    expect(optimisticLock).toBeInstanceOf(NPAPersistenceError);
    expect(optimisticLock.code).toEqual("NPA_OPTIMISTIC_LOCK_FAILED");
  });

  test("migration checksum mismatch uses NPAMigrationError code", () => {
    const error = new NPAMigrationError(
      "Migration init checksum mismatch. The migration file changed after it was applied.",
      {
        code: "NPA_MIGRATION_CHECKSUM_MISMATCH",
        details: {
          migrationName: "init",
          historyChecksum: "old",
          fileChecksum: "new",
        },
      },
    );

    expect(error).toBeInstanceOf(NPAError);
    expect(error).toBeInstanceOf(NPAMigrationError);
    expect(error.code).toEqual("NPA_MIGRATION_CHECKSUM_MISMATCH");
    expect(error.message).toMatch(/checksum mismatch/);
  });
});
