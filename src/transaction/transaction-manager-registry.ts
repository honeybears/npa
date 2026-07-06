import { NPATransactionError } from "../error";
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
      throw new NPATransactionError(`Transaction manager "${name}" is already registered.`, {
        code: "NPA_TRANSACTION_MANAGER_DUPLICATED",
        details: { name },
      });
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
      throw new NPATransactionError(`@Transaction could not find transaction manager "${name}".`, {
        code: "NPA_TRANSACTION_MANAGER_NOT_FOUND",
        details: { name },
      });
    }

    return manager;
  }

  if (transactionManagers.size === 0) {
    return undefined;
  }

  if (transactionManagers.size > 1) {
    throw new NPATransactionError(
      "@Transaction found multiple transaction managers. Pass @Transaction({ manager }), @Transaction({ managerProperty }), or @Transaction({ managerName }).",
      {
        code: "NPA_TRANSACTION_MANAGER_AMBIGUOUS",
        details: { count: transactionManagers.size },
      },
    );
  }

  return transactionManagers.values().next().value;
}
