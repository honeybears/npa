import { AsyncLocalStorage } from "node:async_hooks";
import { NPATransactionError } from "../error";
import { PersistenceContext, runWithPersistenceContext } from "../persistence";
import { RollbackOnlyError } from "./rollback-only-error";
import {
  TransactionManager,
  TransactionOptions,
  TransactionPropagation,
} from "./types";

interface TransactionContext<TResource> {
  readOnly: boolean;
  resource: TResource;
  rollbackOnly: boolean;
  savepointIndex: number;
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

    if (propagation === TransactionPropagation.NESTED && currentContext) {
      return this.transactionalNested(work, currentContext, options);
    }

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

      const persistenceContext = new PersistenceContext({
        readOnly: !!options.readOnly,
      });
      const transactionContext: TransactionContext<TResource> = {
        readOnly: !!options.readOnly,
        resource,
        rollbackOnly: false,
        savepointIndex: 0,
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

  protected createSavepoint(
    _resource: TResource,
    _name: string,
    _options: TransactionOptions,
  ): Promise<void> | void {
    throw new NPATransactionError("Nested transactions are not supported by this transaction manager.", {
      code: "NPA_NESTED_TRANSACTION_UNSUPPORTED",
    });
  }

  protected rollbackToSavepoint(
    _resource: TResource,
    _name: string,
    _options: TransactionOptions,
  ): Promise<void> | void {
    throw new NPATransactionError("Nested transactions are not supported by this transaction manager.", {
      code: "NPA_NESTED_TRANSACTION_UNSUPPORTED",
    });
  }

  protected releaseSavepoint(
    _resource: TResource,
    _name: string,
    _options: TransactionOptions,
  ): Promise<void> | void {
    throw new NPATransactionError("Nested transactions are not supported by this transaction manager.", {
      code: "NPA_NESTED_TRANSACTION_UNSUPPORTED",
    });
  }

  protected releaseTransactionResource(
    _resource: TResource,
    _options: TransactionOptions,
  ): Promise<void> | void {
    return undefined;
  }

  private normalizePropagation(propagation: unknown): TransactionPropagation {
    switch (propagation) {
      case undefined:
      case TransactionPropagation.NESTED:
      case TransactionPropagation.REQUIRED:
        return propagation ?? TransactionPropagation.REQUIRED;
      case TransactionPropagation.REQUIRES_NEW:
        return TransactionPropagation.REQUIRES_NEW;
      default:
        throw new NPATransactionError(`Unsupported transaction propagation: ${String(propagation)}`, {
          code: "NPA_TRANSACTION_PROPAGATION_UNSUPPORTED",
          details: { propagation },
        });
    }
  }

  private async transactionalNested<T>(
    work: () => Promise<T> | T,
    context: TransactionContext<TResource>,
    options: TransactionOptions,
  ): Promise<T> {
    const savepointName = `npa_savepoint_${++context.savepointIndex}`;
    await this.createSavepoint(context.resource, savepointName, options);

    try {
      const persistenceContext = new PersistenceContext({
        readOnly: context.readOnly || !!options.readOnly,
      });
      const result = await runWithPersistenceContext(
        persistenceContext,
        async () => {
          const value = await work();
          await persistenceContext.flush();
          return value;
        },
      );

      await this.releaseSavepoint(context.resource, savepointName, options);
      return result;
    } catch (error) {
      await Promise.resolve(
        this.rollbackToSavepoint(context.resource, savepointName, options),
      ).catch(() => {
        context.rollbackOnly = true;
      });
      throw error;
    }
  }
}
