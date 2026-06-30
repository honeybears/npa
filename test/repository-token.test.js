const assert = require("node:assert/strict");
const test = require("node:test");

const {
  Column,
  Entity,
  Id,
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

  const npa = createNPA({
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
    () => createNPA({ adapter: { createRepository() {} }, repositories: [MissingRepository] }),
    /MissingRepository is missing @Repository\(Entity\)/,
  );
});

test("rejects repository lookups not registered in createNPA", () => {
  class OtherRepository extends NPARepository {}
  Repository(TokenUser)(OtherRepository);

  const npa = createNPA({
    adapter: {
      createRepository(options) {
        return Object.create(options.repository.prototype);
      },
    },
    repositories: [UserRepository],
  });

  assert.throws(
    () => npa.get(OtherRepository),
    /OtherRepository was not registered in createNPA\(\)/,
  );
});
