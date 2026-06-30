export enum NPATransactionPropagation {
  REQUIRED = "REQUIRED",
  REQUIRES_NEW = "REQUIRES_NEW",
}

export enum NPATransactionIsolation {
  READ_UNCOMMITTED = "READ_UNCOMMITTED",
  READ_COMMITTED = "READ_COMMITTED",
  REPEATABLE_READ = "REPEATABLE_READ",
  SERIALIZABLE = "SERIALIZABLE",
}

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
