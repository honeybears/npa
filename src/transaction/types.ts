export enum NPATransactionPropagation {
  REQUIRED = "REQUIRED",
  REQUIRES_NEW = "REQUIRES_NEW",
}

export type NPATransactionIsolation =
  | "read_uncommitted"
  | "read_committed"
  | "repeatable_read"
  | "serializable";

export interface NPATransactionOptions {
  propagation?: NPATransactionPropagation;
  isolation?: NPATransactionIsolation;
  readOnly?: boolean;
}

export interface NPATransactionManager {
  transactional<T>(
    work: () => Promise<T> | T,
    options?: NPATransactionOptions,
  ): Promise<T>;
  isTransactionActive(): boolean;
}
