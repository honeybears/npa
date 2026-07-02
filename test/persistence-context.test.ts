import { describe, expect, test } from "@jest/globals";
import {
  Column,
  Entity,
  Id,
  OptimisticLockError,
  PersistenceContext,
  Version,
} from "../dist";

interface Profile {
  city: string;
}

@Entity({ name: "users" })
class User {
  @Id({ name: "user_id" })
  id!: number;

  @Column({ name: "full_name" })
  name!: string;

  @Column()
  active!: boolean;

  @Column()
  profile!: Profile;

  @Column({ name: "created_at" })
  createdAt!: Date;
}

@Entity({ name: "versioned_users" })
class VersionedUser {
  @Id({ name: "user_id" })
  id!: number;

  @Column({ name: "full_name" })
  name!: string;

  @Version({ name: "lock_version" })
  version!: number;
}

interface DirtyUpdate<TEntity extends object> {
  id: unknown;
  patch: Partial<TEntity>;
}

describe("persistence context", () => {
  test("tracks managed entity changes and flushes property-name patches", async () => {
    const updates: DirtyUpdate<User>[] = [];
    const context = new PersistenceContext();
    const row = {
      user_id: 1,
      full_name: "kim",
      active: true,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    };

    const managed = context.manage<User>(row as unknown as User, {
      entity: User,
      adapter: {
        async updateDirty(_entity, id, patch) {
          updates.push({ id, patch });
          return _entity;
        },
      },
    });

    expect(managed.name).toEqual("kim");

    managed.name = "lee";
    managed.active = false;

    await context.flush();

    expect(row.full_name).toEqual("lee");
    expect(updates).toEqual([{ id: 1, patch: { name: "lee", active: false } }]);

    await context.flush();
    expect(updates.length).toEqual(1);
  });

  test("detects in-place Date changes", async () => {
    const updates: DirtyUpdate<User>[] = [];
    const context = new PersistenceContext();
    const row = {
      user_id: 2,
      full_name: "park",
      active: true,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    };

    const managed = context.manage<User>(row as unknown as User, {
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

    expect(updates.length).toEqual(1);
    expect(updates[0].id).toEqual(2);
    expect(updates[0].patch.createdAt.getUTCFullYear()).toEqual(2027);
  });

  test("does not detect in-place nested object changes", async () => {
    const updates: DirtyUpdate<User>[] = [];
    const context = new PersistenceContext();
    const row = {
      user_id: 6,
      full_name: "kim",
      active: true,
      profile: { city: "seoul" },
    };

    const managed = context.manage<User>(row as unknown as User, {
      entity: User,
      adapter: {
        async updateDirty(_entity, id, patch) {
          updates.push({ id, patch });
          return _entity;
        },
      },
    });

    managed.profile.city = "busan";

    await context.flush();

    expect(updates).toEqual([]);

    managed.profile = { city: "busan" };

    await context.flush();

    expect(updates).toEqual([{ id: 6, patch: { profile: { city: "busan" } } }]);
  });

  test("detaches managed entities before flush", async () => {
    const updates: DirtyUpdate<User>[] = [];
    const context = new PersistenceContext();
    const row = {
      user_id: 3,
      full_name: "choi",
      active: true,
      name: undefined as string | undefined,
    };

    context.manage<User>(row as unknown as User, {
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

    expect(updates).toEqual([]);
  });

  test("keeps dirty snapshots when adapter update fails", async () => {
    const updates: DirtyUpdate<User>[] = [];
    const context = new PersistenceContext();
    const row = { user_id: 7, full_name: "kim", active: true };
    let shouldFail = true;

    const managed = context.manage<User>(row as unknown as User, {
      entity: User,
      adapter: {
        async updateDirty(_entity, id, patch) {
          updates.push({ id, patch });

          if (shouldFail) {
            throw new Error("database update failed");
          }

          return _entity;
        },
      },
    });

    managed.name = "lee";

    await expect(context.flush()).rejects.toThrow(/database update failed/);

    shouldFail = false;

    await context.flush();
    await context.flush();

    expect(updates).toEqual([
      { id: 7, patch: { name: "lee" } },
      { id: 7, patch: { name: "lee" } },
    ]);
  });

  test("uses @Version metadata for optimistic dirty updates", async () => {
    const updates: Array<
      DirtyUpdate<VersionedUser> & {
        expectedVersion: unknown;
        versionColumn: { propertyName: string; columnName: string };
      }
    > = [];
    const context = new PersistenceContext();
    const row = { user_id: 4, full_name: "kim", lock_version: 2 };

    const managed = context.manage<VersionedUser>(
      row as unknown as VersionedUser,
      {
        entity: VersionedUser,
        adapter: {
          async updateDirty(_entity, id, patch, options) {
            if (!options?.versionColumn) {
              throw new Error("Missing version column");
            }
            updates.push({
              id,
              patch,
              expectedVersion: options.expectedVersion,
              versionColumn: {
                propertyName: options.versionColumn.propertyName,
                columnName: options.versionColumn.columnName,
              },
            });
            return {
              user_id: id,
              full_name: patch.name,
              lock_version: 3,
            } as unknown as VersionedUser;
          },
        },
      },
    );

    managed.name = "lee";

    await context.flush();

    expect(row.lock_version).toEqual(3);
    expect(managed.version).toEqual(3);
    expect(updates).toEqual([
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

    const managed = context.manage<VersionedUser>(
      row as unknown as VersionedUser,
      {
        entity: VersionedUser,
        adapter: {
          async updateDirty() {
            return null;
          },
        },
      },
    );

    managed.name = "lee";

    await expect(context.flush()).rejects.toThrow(OptimisticLockError);
  });
});
