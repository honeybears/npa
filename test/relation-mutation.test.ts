import {
  NPARepository,
  NPAPersistenceError,
  createNPARepository,
  type NPARepositoryAdapter,
  type Relation,
} from "../src";

class Role {
  id!: number;
  name!: string;
}

class User {
  id!: number;
  roles?: Relation<Role[]>;
}

class UserRepository extends NPARepository<User, number> {}

function repository(): UserRepository {
  const adapter: NPARepositoryAdapter<User, number> = {
    async findById() {
      return null;
    },
    async findAll() {
      return [];
    },
    async existsById() {
      return false;
    },
    async count() {
      return 0;
    },
    async save(entity) {
      return entity;
    },
    async delete() {
      return 0;
    },
    async deleteById() {
      return 0;
    },
    async deleteAll() {
      return 0;
    },
    async executeDerivedQuery() {
      return undefined;
    },
  };

  return createNPARepository(
    Object.create(UserRepository.prototype),
    adapter,
  );
}

describe("relation mutations", () => {
  test("adds, removes, and sets to-many relation items", async () => {
    const users = repository();
    const user = new User();
    const admin = Object.assign(new Role(), { id: 1, name: "admin" });
    const writer = Object.assign(new Role(), { id: 2, name: "writer" });

    await users.relations(user).roles.add(admin);
    await users.relations(user).roles.add(admin);
    await users.relations(user).roles.add(writer);

    expect(user.roles).toEqual([admin, writer]);

    await users.relations(user).roles.remove(admin);

    expect(user.roles).toEqual([writer]);

    await users.relations(user).roles.set([admin]);

    expect(user.roles).toEqual([admin]);
  });

  test("resolves lazy to-many relation before mutating it", async () => {
    const users = repository();
    const admin = Object.assign(new Role(), { id: 1, name: "admin" });
    const writer = Object.assign(new Role(), { id: 2, name: "writer" });
    const user = Object.assign(new User(), {
      roles: Promise.resolve([admin]),
    });

    await users.relations(user).roles.add(writer);

    expect(user.roles).toEqual([admin, writer]);
  });

  test("rejects non-array relation values", async () => {
    const users = repository();
    const admin = Object.assign(new Role(), { id: 1, name: "admin" });
    const user = Object.assign(new User(), {
      roles: admin,
    }) as User;

    await expect(users.relations(user).roles.add(admin)).rejects.toMatchObject({
      code: "NPA_TO_MANY_RELATION_ARRAY_REQUIRED",
    });
    await expect(users.relations(user).roles.add(admin)).rejects.toThrow(
      NPAPersistenceError,
    );
  });
});
