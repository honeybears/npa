const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AbstractTransactionManager,
  Column,
  Entity,
  getCurrentPersistenceContext,
  Id,
  NPATransactionIsolation,
  NPATransactionPropagation,
  RollbackOnlyError,
  Transaction,
} = require("../dist");

class RecordingTransactionManager extends AbstractTransactionManager {
  constructor() {
    super();
    this.calls = [];
    this.nextId = 0;
  }

  currentId() {
    return this.getCurrentTransactionResource()?.id;
  }

  acquireTransactionResource(options) {
    const resource = { id: ++this.nextId, options };
    this.calls.push(`acquire:${resource.id}`);
    return resource;
  }

  beginTransaction(resource, options) {
    this.calls.push(`begin:${resource.id}:${options.isolation ?? "none"}`);
  }

  commitTransaction(resource) {
    this.calls.push(`commit:${resource.id}`);
  }

  rollbackTransaction(resource) {
    this.calls.push(`rollback:${resource.id}`);
  }

  releaseTransactionResource(resource) {
    this.calls.push(`release:${resource.id}`);
  }
}

class TransactionUser {}

Id()(TransactionUser.prototype, "id");
Column()(TransactionUser.prototype, "name");
Entity({ name: "transaction_users" })(TransactionUser);

test("runs work inside a transaction and commits", async () => {
  const manager = new RecordingTransactionManager();

  const result = await manager.transactional(
    async () => {
      assert.equal(manager.isTransactionActive(), true);
      assert.equal(manager.currentId(), 1);
      return "created";
    },
    { isolation: NPATransactionIsolation.SERIALIZABLE },
  );

  assert.equal(result, "created");
  assert.equal(manager.isTransactionActive(), false);
  assert.deepEqual(manager.calls, [
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
    assert.ok(context);

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

  assert.deepEqual(updates, [
    {
      id: 1,
      patch: { name: "lee" },
      callsBeforeCommit: ["acquire:1", "begin:1:none"],
    },
  ]);
  assert.deepEqual(manager.calls, [
    "acquire:1",
    "begin:1:none",
    "commit:1",
    "release:1",
  ]);
});

test("rolls back and releases when work fails", async () => {
  const manager = new RecordingTransactionManager();

  await assert.rejects(
    () => manager.transactional(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(manager.isTransactionActive(), false);
  assert.deepEqual(manager.calls, [
    "acquire:1",
    "begin:1:none",
    "rollback:1",
    "release:1",
  ]);
});

test("joins an existing required transaction and starts REQUIRES_NEW separately", async () => {
  const manager = new RecordingTransactionManager();

  await manager.transactional(async () => {
    assert.equal(manager.currentId(), 1);

    await manager.transactional(async () => {
      assert.equal(manager.currentId(), 1);
    });

    await manager.transactional(
      async () => {
        assert.equal(manager.currentId(), 2);
      },
      { propagation: NPATransactionPropagation.REQUIRES_NEW },
    );

    assert.equal(manager.currentId(), 1);
  });

  assert.deepEqual(manager.calls, [
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

test("marks joined required transactions rollback-only after an inner failure", async () => {
  const manager = new RecordingTransactionManager();

  await assert.rejects(
    () =>
      manager.transactional(async () => {
        await assert.rejects(
          () =>
            manager.transactional(async () => {
              throw new Error("inner failure");
            }),
          /inner failure/,
        );

        return "outer recovered";
      }),
    RollbackOnlyError,
  );

  assert.deepEqual(manager.calls, [
    "acquire:1",
    "begin:1:none",
    "rollback:1",
    "release:1",
  ]);
});

test("keeps outer transactions committable when a REQUIRES_NEW transaction fails", async () => {
  const manager = new RecordingTransactionManager();

  await manager.transactional(async () => {
    await assert.rejects(
      () =>
        manager.transactional(
          async () => {
            throw new Error("inner failure");
          },
          { propagation: NPATransactionPropagation.REQUIRES_NEW },
        ),
      /inner failure/,
    );
  });

  assert.deepEqual(manager.calls, [
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

test("Transaction decorator resolves a manager from the instance", async () => {
  const manager = new RecordingTransactionManager();

  class UserService {
    constructor(transactionManager) {
      this.transactionManager = transactionManager;
    }

    async create(name) {
      return `${name}:${this.transactionManager.isTransactionActive()}:${this.transactionManager.currentId()}`;
    }
  }

  decorateMethod(UserService, "create", Transaction());

  const service = new UserService(manager);

  assert.equal(await service.create("kim"), "kim:true:1");
  assert.deepEqual(manager.calls, [
    "acquire:1",
    "begin:1:none",
    "commit:1",
    "release:1",
  ]);
});

test("Transaction decorator supports a custom manager property", async () => {
  const manager = new RecordingTransactionManager();

  class UserService {
    constructor(unitOfWork) {
      this.unitOfWork = unitOfWork;
    }

    async count() {
      return this.unitOfWork.isTransactionActive();
    }
  }

  decorateMethod(
    UserService,
    "count",
    Transaction({ managerProperty: "unitOfWork", readOnly: true }),
  );

  const service = new UserService(manager);

  assert.equal(await service.count(), true);
  assert.deepEqual(manager.calls, [
    "acquire:1",
    "begin:1:none",
    "commit:1",
    "release:1",
  ]);
});

function decorateMethod(targetClass, methodName, decorator) {
  const descriptor = Object.getOwnPropertyDescriptor(
    targetClass.prototype,
    methodName,
  );
  decorator(targetClass.prototype, methodName, descriptor);
  Object.defineProperty(targetClass.prototype, methodName, descriptor);
}
