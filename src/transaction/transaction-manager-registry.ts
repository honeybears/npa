import type { TransactionManager } from "./types";

const transactionManagers = new Set<TransactionManager>();
const namedTransactionManagers = new Map<string, TransactionManager>();

export function registerTransactionManager(
  manager: TransactionManager,
  name?: string,
): void {
  if (name) {
    const registered = namedTransactionManagers.get(name);

    if (registered && registered !== manager) {
      throw new Error(`Transaction manager "${name}" is already registered.`);
    }

    namedTransactionManagers.set(name, manager);
  }

  transactionManagers.add(manager);
}

export function clearTransactionManagers(): void {
  transactionManagers.clear();
  namedTransactionManagers.clear();
}

export function resolveRegisteredTransactionManager(
  name?: string,
): TransactionManager | undefined {
  if (name) {
    const manager = namedTransactionManagers.get(name);

    if (!manager) {
      throw new Error(`@Transaction could not find transaction manager "${name}".`);
    }

    return manager;
  }

  if (transactionManagers.size === 0) {
    return undefined;
  }

  if (transactionManagers.size > 1) {
    throw new Error(
      "@Transaction found multiple transaction managers. Pass @Transaction({ manager }), @Transaction({ managerProperty }), or @Transaction({ managerName }).",
    );
  }

  return transactionManagers.values().next().value;
}
