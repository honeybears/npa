import { describe, expect, test } from "@jest/globals";
import {
  CascadeType,
  Column,
  Entity,
  Id,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OptimisticLockError,
  UpdatedAt,
  Version,
} from "../src";
import { PersistenceContext } from "../src/persistence/persistence-context";

interface Profile {
  city: string;
}

@Entity({ name: "teams" })
class Team {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  label!: string;

  @OneToMany(() => User, { mappedBy: "team" })
  members!: User[];
}

@Entity({ name: "roles" })
class Role {
  @Id({ name: "role_id" })
  id!: number;

  @Column()
  label!: string;

  @ManyToMany(() => User, { mappedBy: "roles" })
  users!: User[];
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

  @ManyToOne(() => Team, {
    joinColumn: "team_id",
    cascade: [CascadeType.PERSIST, CascadeType.REMOVE],
  })
  team!: Team;

  @ManyToMany(() => Role, {
    joinTable: "user_roles",
    cascade: [CascadeType.PERSIST, CascadeType.REMOVE],
  })
  roles!: Role[];

  @Column({ name: "created_at" })
  createdAt!: Date;

  @UpdatedAt({ name: "updated_at" })
  updatedAt!: Date;
}

@Entity({ name: "orphan_teams" })
class OrphanTeam {
  @Id({ name: "team_id" })
  id!: number;

  @Column()
  label!: string;

  @OneToMany(() => OrphanUser, {
    mappedBy: "team",
    orphanRemoval: true,
  })
  members!: OrphanUser[];
}

@Entity({ name: "orphan_users" })
class OrphanUser {
  @Id({ name: "user_id" })
  id!: number;

  @Column({ name: "full_name" })
  name!: string;

  @ManyToOne(() => OrphanTeam, { joinColumn: "team_id" })
  team!: OrphanTeam;
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

@Entity({ name: "generated_users" })
class GeneratedUser {
  @Id({ name: "user_id", generationStrategy: "AUTO_INCREMENT" })
  id: number = 0;

  @Column({ name: "full_name" })
  name!: string;
}

interface DirtyUpdate<TEntity extends object> {
  id: unknown;
  patch: Partial<TEntity>;
}

describe("persistence context", () => {
  test("keeps generated entities with falsy ids distinct until insert", async () => {
    const context = new PersistenceContext();
    const inserted: string[] = [];
    let nextId = 1;
    const adapter = {
      async updateDirty(entity: GeneratedUser) {
        return entity;
      },
      async insertManaged(entity: GeneratedUser) {
        inserted.push(entity.name);
        return { user_id: nextId++, full_name: entity.name } as unknown as GeneratedUser;
      },
    };
    const first = Object.assign(new GeneratedUser(), { name: "kim" });
    const second = Object.assign(new GeneratedUser(), { name: "lee" });

    const managedFirst = await context.persist(first, {
      entity: GeneratedUser,
      adapter,
    });
    const managedSecond = await context.persist(second, {
      entity: GeneratedUser,
      adapter,
    });
    await context.flush();

    expect(managedSecond).not.toBe(managedFirst);
    expect(inserted).toEqual(["kim", "lee"]);
    expect(first.id).toEqual(1);
    expect(second.id).toEqual(2);
  });

  test("persists cascaded many-to-one relations before the owning entity", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const team = { label: "platform" } as Team;
    const user = {
      full_name: "kim",
      active: true,
      profile: { city: "seoul" },
      team,
    } as unknown as User;

    const teamAdapter = {
      async updateDirty(entity: Team) {
        return entity;
      },
      async insertManaged(entity: Team) {
        calls.push("team");
        return { team_id: 10, label: entity.label } as unknown as Team;
      },
      async deleteManaged() {
        return 1;
      },
    };
    const userAdapter = {
      async updateDirty(entity: User) {
        return entity;
      },
      async insertManaged(entity: User) {
        calls.push("user");
        expect(entity.team.id).toEqual(10);
        return {
          user_id: 1,
          full_name: entity.name,
          active: entity.active,
        } as unknown as User;
      },
      async deleteManaged() {
        return 1;
      },
      forEntity(entity: typeof Team | typeof User) {
        return entity === Team ? teamAdapter : userAdapter;
      },
    };

    await context.persist(user, { entity: User, adapter: userAdapter });
    await context.flush();

    expect(calls).toEqual(["team", "user"]);
    expect(team.id).toEqual(10);
    expect(user.id).toEqual(1);
  });

  test("persists many-to-many targets and syncs join rows", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const role = { label: "admin" } as Role;
    const user = {
      full_name: "kim",
      active: true,
      profile: { city: "seoul" },
      roles: [role],
    } as unknown as User;

    const roleAdapter = {
      async updateDirty(entity: Role) {
        return entity;
      },
      async insertManaged(entity: Role) {
        calls.push("role");
        return { role_id: 20, label: entity.label } as unknown as Role;
      },
    };
    const userAdapter = {
      async updateDirty(entity: User) {
        return entity;
      },
      async insertManaged(entity: User) {
        calls.push("user");
        return {
          user_id: 1,
          full_name: entity.name,
          active: entity.active,
        } as unknown as User;
      },
      async syncManyToManyRelations(
        _entity: User,
        id: unknown,
        relation: { propertyName: string },
        targetIds: unknown[],
      ) {
        calls.push(`${relation.propertyName}:${id}:${targetIds.join(",")}`);
      },
      forEntity(entity: typeof Role | typeof User) {
        return entity === Role ? roleAdapter : userAdapter;
      },
    };

    await context.persist(user, { entity: User, adapter: userAdapter });
    await context.flush();

    expect(calls).toEqual(["user", "role", "roles:1:20"]);
    expect(user.id).toEqual(1);
    expect(role.id).toEqual(20);
  });

  test("persists lazy cascade relation promises", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const team = { label: "platform" } as Team;
    const user = {
      full_name: "kim",
      active: true,
      profile: { city: "seoul" },
      team: Promise.resolve(team),
    } as unknown as User;

    const teamAdapter = {
      async updateDirty(entity: Team) {
        return entity;
      },
      async insertManaged(entity: Team) {
        calls.push("team");
        return { team_id: 10, label: entity.label } as unknown as Team;
      },
    };
    const userAdapter = {
      async updateDirty(entity: User) {
        return entity;
      },
      async insertManaged(entity: User) {
        calls.push(`user:${entity.team.id}`);
        return {
          user_id: 1,
          full_name: entity.name,
          active: entity.active,
        } as unknown as User;
      },
      forEntity(entity: typeof Team | typeof User) {
        return entity === Team ? teamAdapter : userAdapter;
      },
    };

    await context.persist(user, { entity: User, adapter: userAdapter });
    await context.flush();

    expect(calls).toEqual(["team", "user:10"]);
    expect(user.team).toBe(team);
  });

  test("flushes loaded many-to-many relation changes", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const user = {
      user_id: 1,
      full_name: "kim",
      active: true,
      profile: { city: "seoul" },
      roles: [{ role_id: 10, label: "admin" }],
    } as unknown as User;
    const managed = context.manage(user, {
      entity: User,
      adapter: {
        async updateDirty() {
          throw new Error("scalar update should not run");
        },
        async syncManyToManyRelations(_entity, id, relation, targetIds) {
          calls.push(`${relation.propertyName}:${id}:${targetIds.join(",")}`);
        },
      },
    });

    managed.roles = [
      { role_id: 10, label: "admin" } as unknown as Role,
      { role_id: 20, label: "writer" } as unknown as Role,
    ];

    await context.flush();

    expect(calls).toEqual(["roles:1:10,20"]);
  });

  test("flushes inverse many-to-many relation changes", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const role = {
      role_id: 5,
      label: "admin",
      users: [{ user_id: 1, full_name: "kim", active: true }],
    } as unknown as Role;
    const managed = context.manage(role, {
      entity: Role,
      adapter: {
        async updateDirty() {
          throw new Error("scalar update should not run");
        },
        async syncManyToManyRelations(_entity, id, relation, targetIds) {
          calls.push(`${relation.propertyName}:${id}:${targetIds.join(",")}`);
        },
      },
    });

    managed.users = [
      { user_id: 1, full_name: "kim", active: true } as unknown as User,
      { user_id: 2, full_name: "lee", active: true } as unknown as User,
    ];

    await context.flush();

    expect(calls).toEqual(["users:5:1,2"]);
  });

  test("flushes loaded one-to-many collection changes to the owning foreign key", async () => {
    const context = new PersistenceContext();
    const updates: Array<{ id: unknown; patch: Partial<User> }> = [];
    const team = {
      team_id: 10,
      label: "platform",
      members: [{ user_id: 1, full_name: "kim", active: true }],
    } as unknown as Team;
    const userAdapter = {
      async updateDirty(_entity: User, id: unknown, patch: Partial<User>) {
        updates.push({ id, patch });
        return _entity;
      },
    };
    const teamAdapter = {
      async updateDirty(entity: Team) {
        return entity;
      },
      forEntity(entity: typeof User | typeof Team) {
        return entity === User ? userAdapter : teamAdapter;
      },
    };
    const managed = context.manage(team, { entity: Team, adapter: teamAdapter });

    managed.members = [
      { user_id: 2, full_name: "lee", active: true } as unknown as User,
    ];

    await context.flush();

    expect(updates).toEqual([
      { id: 2, patch: { team: managed } },
      { id: 1, patch: { team: null } },
    ]);
  });

  test("deletes removed one-to-many children when orphanRemoval is enabled", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const team = {
      team_id: 10,
      label: "platform",
      members: [{ user_id: 1, full_name: "kim" }],
    } as unknown as OrphanTeam;
    const userAdapter = {
      async updateDirty(_entity: OrphanUser, id: unknown, patch: Partial<OrphanUser>) {
        calls.push(`update:${id}:${patch.team === team ? "team" : "null"}`);
        return _entity;
      },
      async deleteManaged(_entity: OrphanUser, id: unknown) {
        calls.push(`delete-user:${id}`);
        return 1;
      },
    };
    const teamAdapter = {
      async updateDirty(entity: OrphanTeam) {
        return entity;
      },
      forEntity(entity: typeof OrphanUser | typeof OrphanTeam) {
        return entity === OrphanUser ? userAdapter : teamAdapter;
      },
    };
    const managed = context.manage(team, {
      entity: OrphanTeam,
      adapter: teamAdapter,
    });

    managed.members = [
      { user_id: 2, full_name: "lee" } as unknown as OrphanUser,
    ];

    await context.flush();

    expect(calls).toEqual(["update:2:team", "delete-user:1"]);
  });

  test("deletes orphanRemoval children before removing the parent", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const team = {
      team_id: 10,
      label: "platform",
      members: [{ user_id: 1, full_name: "kim" }],
    } as unknown as OrphanTeam;
    const userAdapter = {
      async updateDirty(entity: OrphanUser) {
        return entity;
      },
      async deleteManaged(_entity: OrphanUser, id: unknown) {
        calls.push(`user:${id}`);
        return 1;
      },
    };
    const teamAdapter = {
      async updateDirty(entity: OrphanTeam) {
        return entity;
      },
      async deleteManaged(_entity: OrphanTeam, id: unknown) {
        calls.push(`team:${id}`);
        return 1;
      },
      forEntity(entity: typeof OrphanUser | typeof OrphanTeam) {
        return entity === OrphanUser ? userAdapter : teamAdapter;
      },
    };

    context.manage(team, { entity: OrphanTeam, adapter: teamAdapter });
    await context.remove(team, { entity: OrphanTeam, adapter: teamAdapter });
    await context.flush();

    expect(calls).toEqual(["user:1", "team:10"]);
  });

  test("removes owning entities before cascaded many-to-one targets", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const team = { team_id: 10, label: "platform" } as unknown as Team;
    const user = {
      user_id: 1,
      full_name: "kim",
      active: true,
      profile: { city: "seoul" },
      team,
    } as unknown as User;

    const teamAdapter = {
      async updateDirty(entity: Team) {
        return entity;
      },
      async deleteManaged(_entity: Team, id: unknown) {
        calls.push(`team:${id}`);
        return 1;
      },
    };
    const userAdapter = {
      async updateDirty(entity: User) {
        return entity;
      },
      async deleteManaged(_entity: User, id: unknown) {
        calls.push(`user:${id}`);
        return 1;
      },
      async deleteManyToManyRelations(
        _entity: User,
        id: unknown,
        relation: { propertyName: string },
      ) {
        calls.push(`${relation.propertyName}:${id}`);
      },
      forEntity(entity: typeof Team | typeof User) {
        return entity === Team ? teamAdapter : userAdapter;
      },
    };

    context.manage(user, { entity: User, adapter: userAdapter });
    await context.remove(user, { entity: User, adapter: userAdapter });
    await context.flush();

    expect(calls).toEqual(["roles:1", "user:1", "team:10"]);
    expect(context.findManagedById(1, { entity: User, adapter: userAdapter }))
      .toBeUndefined();
    expect(context.findManagedById(10, { entity: Team, adapter: teamAdapter }))
      .toBeUndefined();
  });

  test("removes many-to-many targets when REMOVE cascade is configured", async () => {
    const context = new PersistenceContext();
    const calls: string[] = [];
    const role = { role_id: 20, label: "admin" } as unknown as Role;
    const user = {
      user_id: 1,
      full_name: "kim",
      active: true,
      profile: { city: "seoul" },
      roles: [role],
    } as unknown as User;

    const roleAdapter = {
      async updateDirty(entity: Role) {
        return entity;
      },
      async deleteManaged(_entity: Role, id: unknown) {
        calls.push(`role:${id}`);
        return 1;
      },
      async deleteManyToManyRelations(
        _entity: Role,
        id: unknown,
        relation: { propertyName: string },
      ) {
        calls.push(`${relation.propertyName}:${id}`);
      },
    };
    const userAdapter = {
      async updateDirty(entity: User) {
        return entity;
      },
      async deleteManaged(_entity: User, id: unknown) {
        calls.push(`user:${id}`);
        return 1;
      },
      async deleteManyToManyRelations(
        _entity: User,
        id: unknown,
        relation: { propertyName: string },
      ) {
        calls.push(`${relation.propertyName}:${id}`);
      },
      forEntity(entity: typeof Role | typeof User) {
        return entity === Role ? roleAdapter : userAdapter;
      },
    };

    context.manage(user, { entity: User, adapter: userAdapter });
    await context.remove(user, { entity: User, adapter: userAdapter });
    await context.flush();

    expect(calls).toEqual(["users:20", "role:20", "roles:1", "user:1"]);
  });

  test("returns the same managed instance for the same entity id", () => {
    const context = new PersistenceContext();
    const adapter = {
      async updateDirty(entity: User) {
        return entity;
      },
    };
    const first = {
      user_id: 1,
      full_name: "kim",
      active: true,
    };
    const second = {
      user_id: 1,
      full_name: "lee",
      active: false,
    };

    const managedFirst = context.manage<User>(first as unknown as User, {
      entity: User,
      adapter,
    });
    const managedSecond = context.manage<User>(second as unknown as User, {
      entity: User,
      adapter,
    });

    expect(managedSecond).toBe(managedFirst);
    expect(context.findManagedById(1, { entity: User, adapter })).toBe(managedFirst);
    expect(managedSecond.name).toEqual("lee");
    expect(managedSecond.active).toEqual(false);
  });

  test("keeps dirty scalar values while enriching loaded relations", async () => {
    const updates: DirtyUpdate<User>[] = [];
    const context = new PersistenceContext();
    const adapter = {
      async updateDirty(_entity: User, id: unknown, patch: Partial<User>) {
        updates.push({ id, patch });
        return _entity;
      },
    };
    const managed = context.manage<User>(
      {
        user_id: 2,
        full_name: "kim",
        active: true,
        team_id: 10,
      } as unknown as User,
      { entity: User, adapter },
    );

    managed.name = "dirty";

    const same = context.manage<User>(
      {
        user_id: 2,
        full_name: "database",
        active: false,
        team_id: 10,
        team: { team_id: 10, label: "platform" },
      } as unknown as User,
      { entity: User, adapter },
    );

    expect(same).toBe(managed);
    expect(managed.name).toEqual("dirty");
    expect(managed.active).toEqual(true);
    expect(managed.team).toEqual({ team_id: 10, label: "platform" });

    await context.flush();

    expect(updates).toEqual([{ id: 2, patch: { name: "dirty" } }]);
  });

  test("removes identity entries when managed entities are detached", () => {
    const context = new PersistenceContext();
    const adapter = {
      async updateDirty(entity: User) {
        return entity;
      },
    };
    const first = { user_id: 3, full_name: "kim", active: true };
    const second = { user_id: 3, full_name: "lee", active: false };

    const managedFirst = context.manage<User>(first as unknown as User, {
      entity: User,
      adapter,
    });
    context.detachById(3, { entity: User, adapter });
    const managedSecond = context.manage<User>(second as unknown as User, {
      entity: User,
      adapter,
    });

    expect(managedSecond).not.toBe(managedFirst);
    expect(managedSecond.name).toEqual("lee");
  });

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

  test("copies returned updatedAt values into managed entities", async () => {
    const context = new PersistenceContext();
    const oldUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
    const newUpdatedAt = new Date("2026-01-02T00:00:00.000Z");
    const row = {
      user_id: 8,
      full_name: "kim",
      active: true,
      updated_at: oldUpdatedAt,
    };

    const managed = context.manage<User>(row as unknown as User, {
      entity: User,
      adapter: {
        async updateDirty(_entity, id, patch) {
          return {
            user_id: id,
            full_name: patch.name,
            active: true,
            updated_at: newUpdatedAt,
          } as unknown as User;
        },
      },
    });

    managed.name = "lee";

    await context.flush();

    expect(row.updated_at).toEqual(newUpdatedAt);
    expect(managed.updatedAt).toEqual(newUpdatedAt);
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
