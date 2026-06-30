import { AsyncLocalStorage } from "node:async_hooks";
import { PersistenceContext, runWithPersistenceContext } from "../persistence";
import { RollbackOnlyError } from "./rollback-only-error";
import {
  NPATransactionManager,
  NPATransactionOptions,
  NPATransactionPropagation,
} from "./types";

interface TransactionContext<TResource> {
  resource: TResource;
  rollbackOnly: boolean;
}

export abstract class AbstractTransactionManager<TResource>
  implements NPATransactionManager
{
  private readonly storage = new AsyncLocalStorage<TransactionContext<TResource>>();

  async transactional<T>(
    work: () => Promise<T> | T,
    options: NPATransactionOptions = {},
  ): Promise<T> {
    const propagation = this.normalizePropagation(options.propagation);

    const currentContext = this.storage.getStore();

    if (propagation === NPATransactionPropagation.REQUIRED && currentContext) {
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
    options: NPATransactionOptions,
  ): Promise<TResource> | TResource;

  protected abstract beginTransaction(
    resource: TResource,
    options: NPATransactionOptions,
  ): Promise<void> | void;

  protected abstract commitTransaction(
    resource: TResource,
    options: NPATransactionOptions,
  ): Promise<void> | void;

  protected abstract rollbackTransaction(
    resource: TResource,
    options: NPATransactionOptions,
  ): Promise<void> | void;

  protected releaseTransactionResource(
    _resource: TResource,
    _options: NPATransactionOptions,
  ): Promise<void> | void {
    return undefined;
  }

  private normalizePropagation(propagation: unknown): NPATransactionPropagation {
    switch (propagation) {
      case undefined:
      case NPATransactionPropagation.REQUIRED:
      case "required":
        return NPATransactionPropagation.REQUIRED;
      case NPATransactionPropagation.REQUIRES_NEW:
      case "requires_new":
        return NPATransactionPropagation.REQUIRES_NEW;
      default:
        throw new Error(`Unsupported transaction propagation: ${String(propagation)}`);
    }
  }
}
