import { TransactionManager, TransactionOptions } from "./types";
import { resolveRegisteredTransactionManager } from "./transaction-manager-registry";

export interface TransactionDecoratorOptions
  extends TransactionOptions {
  manager?: TransactionManager;
  managerName?: string;
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
      const {
        manager,
        managerName,
        managerProperty,
        ...transactionOptions
      } = options;
      const transactionManager = resolveTransactionManager(
        this,
        manager,
        managerName,
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
  managerName: string | undefined,
  managerProperty: string | undefined,
): TransactionManager {
  if (manager) {
    return manager;
  }

  if (managerProperty) {
    const value = (target as Record<string, unknown> | undefined)?.[
      managerProperty
    ];

    if (isTransactionManager(value)) {
      return value;
    }

    throw new Error(
      `@Transaction could not find a transaction manager. Add a ${managerProperty} property or pass @Transaction({ manager }).`,
    );
  }

  if (managerName) {
    const registered = resolveRegisteredTransactionManager(managerName);

    if (registered) {
      return registered;
    }
  }

  const propertyName = managerProperty ?? "transactionManager";
  const value = (target as Record<string, unknown> | undefined)?.[propertyName];

  if (isTransactionManager(value)) {
    return value;
  }

  const registered = resolveRegisteredTransactionManager();

  if (registered) {
    return registered;
  }

  throw new Error(
    `@Transaction could not find a transaction manager. Add a ${propertyName} property, pass @Transaction({ manager }), or register one with new NPA({ transactionManager }).`,
  );
}

function isTransactionManager(value: unknown): value is TransactionManager {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TransactionManager).transactional === "function"
  );
}
