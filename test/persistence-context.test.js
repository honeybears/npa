const assert = require("node:assert/strict");
const test = require("node:test");

const {
  Column,
  Entity,
  Id,
  OptimisticLockError,
  PersistenceContext,
  Version,
} = require("../dist");

class User {}
class VersionedUser {}

Id({ name: "user_id" })(User.prototype, "id");
Column({ name: "full_name" })(User.prototype, "name");
Column()(User.prototype, "active");
Column({ name: "created_at" })(User.prototype, "createdAt");
Entity({ name: "users" })(User);

Id({ name: "user_id" })(VersionedUser.prototype, "id");
Column({ name: "full_name" })(VersionedUser.prototype, "name");
Version({ name: "lock_version" })(VersionedUser.prototype, "version");
Entity({ name: "versioned_users" })(VersionedUser);

test("tracks managed entity changes and flushes property-name patches", async () => {
  const updates = [];
  const context = new PersistenceContext();
  const row = {
    user_id: 1,
    full_name: "kim",
    active: true,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };

  const managed = context.manage(row, {
    entity: User,
    adapter: {
      async updateDirty(_entity, id, patch) {
        updates.push({ id, patch });
        return _entity;
      },
    },
  });

  assert.equal(managed.name, "kim");

  managed.name = "lee";
  managed.active = false;

  await context.flush();

  assert.equal(row.full_name, "lee");
  assert.deepEqual(updates, [
    { id: 1, patch: { name: "lee", active: false } },
  ]);

  await context.flush();
  assert.equal(updates.length, 1);
});

test("detects in-place Date changes", async () => {
  const updates = [];
  const context = new PersistenceContext();
  const row = {
    user_id: 2,
    full_name: "park",
    active: true,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };

  const managed = context.manage(row, {
    entity: User,
    adapter: {
      async updateDirty(_entity, id, patch) {
        updates.push({ id, patch });
        return _entity;
      },
    },
  });

  managed.createdAt.setUTCFullYear(2027);

  await context.flush();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 2);
  assert.equal(updates[0].patch.createdAt.getUTCFullYear(), 2027);
});

test("detaches managed entities before flush", async () => {
  const updates = [];
  const context = new PersistenceContext();
  const row = { user_id: 3, full_name: "choi", active: true };

  context.manage(row, {
    entity: User,
    adapter: {
      async updateDirty(_entity, id, patch) {
        updates.push({ id, patch });
        return _entity;
      },
    },
  });

  row.name = "jung";
  context.detach(row);
  await context.flush();

  assert.deepEqual(updates, []);
});


test("uses @Version metadata for optimistic dirty updates", async () => {
  const updates = [];
  const context = new PersistenceContext();
  const row = { user_id: 4, full_name: "kim", lock_version: 2 };

  const managed = context.manage(row, {
    entity: VersionedUser,
    adapter: {
      async updateDirty(_entity, id, patch, options) {
        updates.push({
          id,
          patch,
          expectedVersion: options.expectedVersion,
          versionColumn: {
            propertyName: options.versionColumn.propertyName,
            columnName: options.versionColumn.columnName,
          },
        });
        return { user_id: id, full_name: patch.name, lock_version: 3 };
      },
    },
  });

  managed.name = "lee";

  await context.flush();

  assert.equal(row.lock_version, 3);
  assert.equal(managed.version, 3);
  assert.deepEqual(updates, [
    {
      id: 4,
      patch: { name: "lee" },
      expectedVersion: 2,
      versionColumn: { propertyName: "version", columnName: "lock_version" },
    },
  ]);
});

test("throws OptimisticLockError when a versioned dirty update affects no rows", async () => {
  const context = new PersistenceContext();
  const row = { user_id: 5, full_name: "kim", lock_version: 7 };

  const managed = context.manage(row, {
    entity: VersionedUser,
    adapter: {
      async updateDirty() {
        return null;
      },
    },
  });

  managed.name = "lee";

  await assert.rejects(() => context.flush(), OptimisticLockError);
});
