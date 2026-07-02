import { TransactionManager, TransactionOptions } from "./types";

export interface TransactionDecoratorOptions
  extends TransactionOptions {
  manager?: TransactionManager;
  managerProperty?: string;
}

export function Transaction(
  options: TransactionDecoratorOptions = {},
): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;

    if (typeof original !== "function") {
      throw new Error("@Transaction can only decorate methods.");
    }

    descriptor.value = async function transactionalMethod(
      ...args: unknown[]
    ): Promise<unknown> {
      const { manager, managerProperty, ...transactionOptions } = options;
      const transactionManager = resolveTransactionManager(
        this,
        manager,
        managerProperty,
      );

      return transactionManager.transactional(
        () => original.apply(this, args),
        transactionOptions,
      );
    };

    return descriptor;
  };
}

export const Transactional = Transaction;

function resolveTransactionManager(
  target: unknown,
  manager: TransactionManager | undefined,
  managerProperty: string | undefined,
): TransactionManager {
  if (manager) {
    return manager;
  }

  const propertyName = managerProperty ?? "transactionManager";
  const value = (target as Record<string, unknown> | undefined)?.[propertyName];

  if (isTransactionManager(value)) {
    return value;
  }

  throw new Error(
    `@Transaction could not find a transaction manager. Add a ${propertyName} property or pass @Transaction({ manager }).`,
  );
}

function isTransactionManager(value: unknown): value is TransactionManager {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TransactionManager).transactional === "function"
  );
}
