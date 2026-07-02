export enum TransactionPropagation {
  REQUIRED = "REQUIRED",
  REQUIRES_NEW = "REQUIRES_NEW",
}

export enum TransactionIsolation {
  READ_UNCOMMITTED = "READ_UNCOMMITTED",
  READ_COMMITTED = "READ_COMMITTED",
  REPEATABLE_READ = "REPEATABLE_READ",
  SERIALIZABLE = "SERIALIZABLE",
}

export interface TransactionOptions {
  propagation?: TransactionPropagation;
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}

export interface TransactionManager {
  transactional<T>(
    work: () => Promise<T> | T,
    options?: TransactionOptions,
  ): Promise<T>;
  isTransactionActive(): boolean;
}
