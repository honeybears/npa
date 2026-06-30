import { AsyncLocalStorage } from "node:async_hooks";
import { PersistenceContext } from "./persistence-context";

const storage = new AsyncLocalStorage<PersistenceContext>();

export function runWithPersistenceContext<T>(
  context: PersistenceContext,
  work: () => Promise<T> | T,
): Promise<T> | T {
  return storage.run(context, work);
}

export function getCurrentPersistenceContext(): PersistenceContext | undefined {
  return storage.getStore();
}
