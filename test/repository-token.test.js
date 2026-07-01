const assert = require("node:assert/strict");
const test = require("node:test");

const {
  Column,
  Entity,
  Id,
  NPA,
  NPARepository,
  Repository,
  createNPA,
} = require("../dist");

class TokenUser {}

Id({ name: "user_id" })(TokenUser.prototype, "id");
Column({ name: "full_name" })(TokenUser.prototype, "name");
Entity({ name: "users" })(TokenUser);

class UserRepository extends NPARepository {
  helperName() {
    return "users";
  }
}

Repository(TokenUser)(UserRepository);

class AutoTokenUser {}

Id()(AutoTokenUser.prototype, "id");
Column()(AutoTokenUser.prototype, "name");
Entity({ name: "auto_users" })(AutoTokenUser);

class AutoUserRepository extends NPARepository {}

Repository(AutoTokenUser)(AutoUserRepository);

test("auto-registers imported @Repository tokens when repositories are omitted", async () => {
  const created = [];
  const adapter = {
    createRepository(options) {
      created.push(options.repository);

      return Object.assign(Object.create(options.repository.prototype), {
        async findById(id) {
          return { id };
        },
      });
    },
  };

  const npa = new NPA({ adapter });
  const users = npa.get(AutoUserRepository);

  assert.equal(users instanceof AutoUserRepository, true);
  assert.deepEqual(await users.findById(10), { id: 10 });
  assert.equal(created.includes(UserRepository), true);
  assert.equal(created.includes(AutoUserRepository), true);
});

test("creates repositories from @Repository abstract-class tokens", async () => {
  const created = [];
  const adapter = {
    createRepository(options) {
      created.push(options);

      return Object.assign(Object.create(options.repository.prototype), {
        async findById(id) {
          return { id };
        },
      });
    },
  };

  const npa = new NPA({
    adapter,
    repositories: [UserRepository],
  });
  const users = npa.get(UserRepository);

  assert.equal(users instanceof UserRepository, true);
  assert.equal(users.helperName(), "users");
  assert.deepEqual(await users.findById(1), { id: 1 });
  assert.equal(created[0].entity, TokenUser);
  assert.equal(created[0].repository, UserRepository);
});

test("rejects repositories without @Repository metadata", () => {
  class MissingRepository extends NPARepository {}

  assert.throws(
    () => new NPA({ adapter: { createRepository() {} }, repositories: [MissingRepository] }),
    /MissingRepository is missing @Repository\(Entity\)/,
  );
});

test("keeps explicit repository lists scoped to the provided tokens", () => {
  class OtherRepository extends NPARepository {}
  Repository(TokenUser)(OtherRepository);

  const npa = new NPA({
    adapter: {
      createRepository(options) {
        return Object.create(options.repository.prototype);
      },
    },
    repositories: [UserRepository],
  });

  assert.throws(
    () => npa.get(OtherRepository),
    /OtherRepository was not registered in this NPA instance/,
  );
});

test("createNPA remains a compatibility wrapper", () => {
  const npa = createNPA({
    adapter: {
      createRepository(options) {
        return Object.create(options.repository.prototype);
      },
    },
    repositories: [UserRepository],
  });

  assert.equal(npa.get(UserRepository) instanceof UserRepository, true);
});
