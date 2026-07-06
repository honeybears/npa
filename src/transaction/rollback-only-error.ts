import { NPATransactionError } from "../error";

export class RollbackOnlyError extends NPATransactionError {
  constructor() {
    super("Transaction was marked rollback-only and cannot be committed.", {
      code: "NPA_ROLLBACK_ONLY",
    });
  }
}
