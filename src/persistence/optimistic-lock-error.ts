import { NPAPersistenceError } from "../error";

export class OptimisticLockError extends NPAPersistenceError {
  constructor(
    readonly entityName: string,
    readonly id: unknown,
    readonly expectedVersion: unknown,
  ) {
    super(
      `Optimistic lock failed for ${entityName}#${String(id)} at version ${String(expectedVersion)}.`,
      {
        code: "NPA_OPTIMISTIC_LOCK_FAILED",
        details: { entityName, id, expectedVersion },
      },
    );
  }
}
