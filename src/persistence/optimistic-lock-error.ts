export class OptimisticLockError extends Error {
  constructor(
    readonly entityName: string,
    readonly id: unknown,
    readonly expectedVersion: unknown,
  ) {
    super(
      `Optimistic lock failed for ${entityName}#${String(id)} at version ${String(expectedVersion)}.`,
    );
    this.name = "OptimisticLockError";
  }
}
