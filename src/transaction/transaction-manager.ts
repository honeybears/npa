import { AsyncLocalStorage } from "node:async_hooks";
import { PersistenceContext, runWithPersistenceContext } from "../persistence";
import { RollbackOnlyError } from "./rollback-only-error";
import {
  TransactionManager,
  TransactionOptions,
  TransactionPropagation,
} from "./types";

interface TransactionContext<TResource> {
  resource: TResource;
  rollbackOnly: boolean;
}

export abstract class AbstractTransactionManager<TResource>
  implements TransactionManager
{
  private readonly storage = new AsyncLocalStorage<TransactionContext<TResource>>();

  async transactional<T>(
    work: () => Promise<T> | T,
    options: TransactionOptions = {},
  ): Promise<T> {
    const propagation = this.normalizePropagation(options.propagation);

    const currentContext = this.storage.getStore();

    if (propagation === TransactionPropagation.REQUIRED && currentContext) {
      try {
        return await Promise.resolve(work());
      } catch (error) {
        currentContext.rollbackOnly = true;
        throw error;
      }
    }

    const resource = await this.acquireTransactionResource(options);
    let began = false;
    let committed = false;

    try {
      await this.beginTransaction(resource, options);
      began = true;

      const persistenceContext = new PersistenceContext();
      const transactionContext: TransactionContext<TResource> = {
        resource,
        rollbackOnly: false,
      };
      const result = await this.storage.run(transactionContext, () =>
        runWithPersistenceContext(persistenceContext, async () => {
          const value = await work();

          if (transactionContext.rollbackOnly) {
            throw new RollbackOnlyError();
          }

          await persistenceContext.flush();
          return value;
        }),
      );

      await this.commitTransaction(resource, options);
      committed = true;

      return result;
    } catch (error) {
      if (began && !committed) {
        await Promise.resolve(
          this.rollbackTransaction(resource, options),
        ).catch(() => undefined);
      }

      throw error;
    } finally {
      await this.releaseTransactionResource(resource, options);
    }
  }

  isTransactionActive(): boolean {
    return !!this.storage.getStore();
  }

  protected getCurrentTransactionResource(): TResource | undefined {
    return this.storage.getStore()?.resource;
  }

  protected abstract acquireTransactionResource(
    options: TransactionOptions,
  ): Promise<TResource> | TResource;

  protected abstract beginTransaction(
    resource: TResource,
    options: TransactionOptions,
  ): Promise<void> | void;

  protected abstract commitTransaction(
    resource: TResource,
    options: TransactionOptions,
  ): Promise<void> | void;

  protected abstract rollbackTransaction(
    resource: TResource,
    options: TransactionOptions,
  ): Promise<void> | void;

  protected releaseTransactionResource(
    _resource: TResource,
    _options: TransactionOptions,
  ): Promise<void> | void {
    return undefined;
  }

  private normalizePropagation(propagation: unknown): TransactionPropagation {
    switch (propagation) {
      case undefined:
      case TransactionPropagation.REQUIRED:
        return TransactionPropagation.REQUIRED;
      case TransactionPropagation.REQUIRES_NEW:
        return TransactionPropagation.REQUIRES_NEW;
      default:
        throw new Error(`Unsupported transaction propagation: ${String(propagation)}`);
    }
  }
}
