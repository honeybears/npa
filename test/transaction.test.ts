import { afterEach, describe, expect, test } from "@jest/globals";
import {
  AbstractTransactionManager,
  Column,
  Entity,
  createNPA,
  getCurrentPersistenceContext,
  Id,
  RollbackOnlyError,
  Transactional,
  TransactionIsolation,
  TransactionOptions,
  TransactionPropagation,
} from "../src";
import { clearTransactionManagers } from "../src/transaction/transaction-manager-registry";

interface RecordingResource {
  id: number;
  options: TransactionOptions;
}

class RecordingTransactionManager extends AbstractTransactionManager<RecordingResource> {
  calls: string[] = [];
  private nextId = 0;

  currentId(): number | undefined {
    return this.getCurrentTransactionResource()?.id;
  }

  currentOptions(): TransactionOptions | undefined {
    return this.getCurrentTransactionResource()?.options;
  }

  protected acquireTransactionResource(
    options: TransactionOptions,
  ): RecordingResource {
    const resource = { id: ++this.nextId, options };
    this.calls.push(`acquire:${resource.id}`);
    return resource;
  }

  protected beginTransaction(
    resource: RecordingResource,
    options: TransactionOptions,
  ): void {
    this.calls.push(`begin:${resource.id}:${options.isolation ?? "none"}`);
  }

  protected commitTransaction(resource: RecordingResource): void {
    this.calls.push(`commit:${resource.id}`);
  }

  protected rollbackTransaction(resource: RecordingResource): void {
    this.calls.push(`rollback:${resource.id}`);
  }

  protected createSavepoint(
    resource: RecordingResource,
    name: string,
  ): void {
    this.calls.push(`savepoint:${resource.id}:${name}`);
  }

  protected rollbackToSavepoint(
    resource: RecordingResource,
    name: string,
  ): void {
    this.calls.push(`rollback-savepoint:${resource.id}:${name}`);
  }

  protected releaseSavepoint(
    resource: RecordingResource,
    name: string,
  ): void {
    this.calls.push(`release-savepoint:${resource.id}:${name}`);
  }

  protected releaseTransactionResource(resource: RecordingResource): void {
    this.calls.push(`release:${resource.id}`);
  }
}

afterEach(() => {
  clearTransactionManagers();
});

class TransactionUser {}

Id()(TransactionUser.prototype, "id");
Column()(TransactionUser.prototype, "name");
Entity({ name: "transaction_users" })(TransactionUser);
describe("transaction manager", () => {
  test("runs work inside a transaction and commits", async () => {
    const manager = new RecordingTransactionManager();

    const result = await manager.transactional(
      async () => {
        expect(manager.isTransactionActive()).toEqual(true);
        expect(manager.currentId()).toEqual(1);
        return "created";
      },
      { isolation: TransactionIsolation.SERIALIZABLE },
    );

    expect(result).toEqual("created");
    expect(manager.isTransactionActive()).toEqual(false);
    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:SERIALIZABLE",
      "commit:1",
      "release:1",
    ]);
  });

  test("flushes dirty managed entities before commit", async () => {
    const manager = new RecordingTransactionManager();
    const updates = [];
    const row = { id: 1, name: "kim" };

    await manager.transactional(async () => {
      const context = getCurrentPersistenceContext();
      expect(context).toBeTruthy();

      context.manage(row, {
        entity: TransactionUser,
        adapter: {
          async updateDirty(_entity, id, patch) {
            updates.push({
              id,
              patch,
              callsBeforeCommit: [...manager.calls],
            });
            return _entity;
          },
        },
      });

      row.name = "lee";
    });

    expect(updates).toEqual([
      {
        id: 1,
        patch: { name: "lee" },
        callsBeforeCommit: ["acquire:1", "begin:1:none"],
      },
    ]);
    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "commit:1",
      "release:1",
    ]);
  });

  test("rolls back and releases when work fails", async () => {
    const manager = new RecordingTransactionManager();

    await expect(manager.transactional(async () => {
        throw new Error("boom");
      })).rejects.toThrow(/boom/);

    expect(manager.isTransactionActive()).toEqual(false);
    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "rollback:1",
      "release:1",
    ]);
  });

  test("joins an existing required transaction and starts REQUIRES_NEW separately", async () => {
    const manager = new RecordingTransactionManager();

    await manager.transactional(async () => {
      expect(manager.currentId()).toEqual(1);

      await manager.transactional(async () => {
        expect(manager.currentId()).toEqual(1);
      });

      await manager.transactional(
        async () => {
          expect(manager.currentId()).toEqual(2);
        },
        { propagation: TransactionPropagation.REQUIRES_NEW },
      );

      expect(manager.currentId()).toEqual(1);
    });

    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "acquire:2",
      "begin:2:none",
      "commit:2",
      "release:2",
      "commit:1",
      "release:1",
    ]);
  });

  test("keeps joined required transaction options scoped to the outer resource", async () => {
    const manager = new RecordingTransactionManager();

    await manager.transactional(
      async () => {
        expect(manager.currentOptions()).toEqual({
          isolation: TransactionIsolation.READ_COMMITTED,
        });

        await manager.transactional(
          async () => {
            expect(manager.currentOptions()).toEqual({
              isolation: TransactionIsolation.READ_COMMITTED,
            });
          },
          {
            isolation: TransactionIsolation.SERIALIZABLE,
            readOnly: true,
          },
        );

        expect(manager.currentOptions()).toEqual({
          isolation: TransactionIsolation.READ_COMMITTED,
        });
      },
      { isolation: TransactionIsolation.READ_COMMITTED },
    );

    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:READ_COMMITTED",
      "commit:1",
      "release:1",
    ]);
  });

  test("marks joined required transactions rollback-only after an inner failure", async () => {
    const manager = new RecordingTransactionManager();

    await expect(
      manager.transactional(async () => {
          await expect(
            manager.transactional(async () => {
              throw new Error("inner failure");
            }),
          ).rejects.toThrow(/inner failure/);

          return "outer recovered";
        }),
    ).rejects.toThrow(RollbackOnlyError);

    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "rollback:1",
      "release:1",
    ]);
  });

  test("keeps outer transactions committable when a REQUIRES_NEW transaction fails", async () => {
    const manager = new RecordingTransactionManager();

    await manager.transactional(async () => {
      await expect(
        manager.transactional(
          async () => {
            throw new Error("inner failure");
          },
          { propagation: TransactionPropagation.REQUIRES_NEW },
        ),
      ).rejects.toThrow(/inner failure/);
    });

    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "acquire:2",
      "begin:2:none",
      "rollback:2",
      "release:2",
      "commit:1",
      "release:1",
    ]);
  });

  test("rolls back nested transactions to a savepoint without marking outer rollback-only", async () => {
    const manager = new RecordingTransactionManager();

    await manager.transactional(async () => {
      await manager.transactional(
        async () => {
          expect(manager.currentId()).toEqual(1);
        },
        { propagation: TransactionPropagation.NESTED },
      );

      await expect(
        manager.transactional(
          async () => {
            throw new Error("nested failure");
          },
          { propagation: TransactionPropagation.NESTED },
        ),
      ).rejects.toThrow(/nested failure/);

      expect(manager.currentId()).toEqual(1);
    });

    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "savepoint:1:npa_savepoint_1",
      "release-savepoint:1:npa_savepoint_1",
      "savepoint:1:npa_savepoint_2",
      "rollback-savepoint:1:npa_savepoint_2",
      "commit:1",
      "release:1",
    ]);
  });

  test("rejects dirty checking flushes in read-only transactions", async () => {
    const manager = new RecordingTransactionManager();
    const updates = [];
    const row = { id: 1, name: "kim" };

    await expect(
      manager.transactional(
        async () => {
          const context = getCurrentPersistenceContext();

          context.manage(row, {
            entity: TransactionUser,
            adapter: {
              async updateDirty(_entity, id, patch) {
                updates.push({ id, patch });
                return _entity;
              },
            },
          });

          row.name = "lee";
        },
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);

    expect(updates).toEqual([]);
    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "rollback:1",
      "release:1",
    ]);
  });

  test("rejects persist and remove in read-only transactions", async () => {
    const manager = new RecordingTransactionManager();
    const adapter = {
      async updateDirty(entity) {
        return entity;
      },
      async insertManaged(entity) {
        return entity;
      },
      async deleteManaged() {
        return undefined;
      },
    };

    await expect(
      manager.transactional(
        async () => {
          const context = getCurrentPersistenceContext();
          await context.persist(new TransactionUser(), {
            entity: TransactionUser,
            adapter,
          });
        },
        { readOnly: true },
      ),
    ).rejects.toThrow(/Cannot persist/);

    await expect(
      manager.transactional(
        async () => {
          const context = getCurrentPersistenceContext();
          await context.remove(Object.assign(new TransactionUser(), { id: 1 }), {
            entity: TransactionUser,
            adapter,
          });
        },
        { readOnly: true },
      ),
    ).rejects.toThrow(/Cannot remove/);

    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "rollback:1",
      "release:1",
      "acquire:2",
      "begin:2:none",
      "rollback:2",
      "release:2",
    ]);
  });

  test("Transactional decorator resolves a manager from the instance", async () => {
    const manager = new RecordingTransactionManager();

    class UserService {
      constructor(private readonly transactionManager: RecordingTransactionManager) {}

      async create(name: string): Promise<string> {
        return `${name}:${this.transactionManager.isTransactionActive()}:${this.transactionManager.currentId()}`;
      }
    }

    decorateMethod(UserService, "create", Transactional());

    const service = new UserService(manager);

    expect(await service.create("kim")).toEqual("kim:true:1");
    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "commit:1",
      "release:1",
    ]);
  });

  test("Transactional decorator supports a custom manager property", async () => {
    const manager = new RecordingTransactionManager();

    class UserService {
      constructor(private readonly unitOfWork: RecordingTransactionManager) {}

      async count(): Promise<boolean> {
        return this.unitOfWork.isTransactionActive();
      }
    }

    decorateMethod(
      UserService,
      "count",
      Transactional({ managerProperty: "unitOfWork", readOnly: true }),
    );

    const service = new UserService(manager);

    expect(await service.count()).toEqual(true);
    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "commit:1",
      "release:1",
    ]);
  });

  test("Transactional decorator resolves a manager registered by NPA", async () => {
    const manager = new RecordingTransactionManager();

    createNPA({
      adapter: {
        createRepository() {
          throw new Error("unexpected repository creation");
        },
      },
      repositories: [],
      transactionManager: manager,
    });

    class UserService {
      async count(): Promise<boolean> {
        return manager.isTransactionActive();
      }
    }

    decorateMethod(UserService, "count", Transactional());

    expect(await new UserService().count()).toEqual(true);
    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "commit:1",
      "release:1",
    ]);
  });

  test("Transactional decorator resolves a manager from the NPA adapter", async () => {
    const manager = new RecordingTransactionManager();

    createNPA({
      adapter: {
        transactionManager: manager,
        createRepository() {
          throw new Error("unexpected repository creation");
        },
      },
      repositories: [],
    });

    class UserService {
      async count(): Promise<boolean> {
        return manager.isTransactionActive();
      }
    }

    decorateMethod(UserService, "count", Transactional());

    expect(await new UserService().count()).toEqual(true);
    expect(manager.calls).toEqual([
      "acquire:1",
      "begin:1:none",
      "commit:1",
      "release:1",
    ]);
  });

  test("Transactional decorator requires a name when multiple managers are registered", async () => {
    const userManager = new RecordingTransactionManager();
    const auditManager = new RecordingTransactionManager();
    const adapter = {
      createRepository() {
        throw new Error("unexpected repository creation");
      },
    };

    createNPA({
      adapter,
      name: "user",
      repositories: [],
      transactionManager: userManager,
    });
    createNPA({
      adapter,
      name: "audit",
      repositories: [],
      transactionManager: auditManager,
    });

    class UserService {
      async save(): Promise<string> {
        return `user:${userManager.isTransactionActive()}:audit:${auditManager.isTransactionActive()}`;
      }

      async writeAudit(): Promise<string> {
        return `user:${userManager.isTransactionActive()}:audit:${auditManager.isTransactionActive()}`;
      }
    }

    decorateMethod(UserService, "save", Transactional());
    decorateMethod(
      UserService,
      "writeAudit",
      Transactional({ managerName: "audit" }),
    );

    const service = new UserService();

    await expect(service.save()).rejects.toThrow(/multiple transaction managers/);
    expect(await service.writeAudit()).toEqual("user:false:audit:true");
  });
});

function decorateMethod(
  targetClass: Function,
  methodName: string,
  decorator: MethodDecorator,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    targetClass.prototype,
    methodName,
  );
  if (!descriptor) {
    throw new Error(`Missing method descriptor: ${methodName}`);
  }
  decorator(targetClass.prototype, methodName, descriptor);
  Object.defineProperty(targetClass.prototype, methodName, descriptor);
}
