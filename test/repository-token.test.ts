import { describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { Column, Entity, Id, NPA, NPARepository, Repository, createNPA, type NPACreateRepositoryOptions, type NPARuntimeAdapter } from "../dist";

class TokenUser {
  id!: number;
  name!: string;
}

Id({ name: "user_id" })(TokenUser.prototype, "id");
Column({ name: "full_name" })(TokenUser.prototype, "name");
Entity({ name: "users" })(TokenUser);

abstract class UserRepository extends NPARepository<TokenUser, number> {
  helperName(): string {
    return "users";
  }
}

Repository(TokenUser)(UserRepository);

class AutoTokenUser {
  id!: number;
  name!: string;
}

Id()(AutoTokenUser.prototype, "id");
Column()(AutoTokenUser.prototype, "name");
Entity({ name: "auto_users" })(AutoTokenUser);

abstract class AutoUserRepository extends NPARepository<AutoTokenUser, number> {}

Repository(AutoTokenUser)(AutoUserRepository);
describe("repository tokens", () => {
  test("reports missing repository bootstrap imports", () => {
    const script = `
  (async () => {
    const { NPA } = await import("./dist/index.js");

    try {
      new NPA({
        adapter: {
          createRepository() {
            throw new Error("adapter should not be called");
          },
        },
      });
      process.exitCode = 1;
    } catch (error) {
      console.log(error.message);
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toEqual(0);
    expect(result.stdout).toMatch(/No @Repository metadata has been loaded/);
    expect(result.stdout).toMatch(/import "\.\/repositories"/);
  });

  test("auto-registers imported @Repository tokens when repositories are omitted", async () => {
    const created: unknown[] = [];
    const adapter = {
      createRepository(options: NPACreateRepositoryOptions) {
        created.push(options.repository);

        return Object.assign(Object.create(options.repository.prototype), {
          async findById(id: unknown) {
            return { id };
          },
        });
      },
    } as unknown as NPARuntimeAdapter;

    const npa = new NPA({ adapter });
    const users = npa.get(AutoUserRepository);

    expect(users instanceof AutoUserRepository).toEqual(true);
    expect(await users.findById(10)).toEqual({ id: 10 });
    expect(created.includes(UserRepository)).toEqual(true);
    expect(created.includes(AutoUserRepository)).toEqual(true);
  });

  test("creates repositories from @Repository abstract-class tokens", async () => {
    const created: NPACreateRepositoryOptions[] = [];
    const adapter = {
      createRepository(options: NPACreateRepositoryOptions) {
        created.push(options);

        return Object.assign(Object.create(options.repository.prototype), {
          async findById(id: unknown) {
            return { id };
          },
        });
      },
    } as unknown as NPARuntimeAdapter;

    const npa = new NPA({
      adapter,
      repositories: [UserRepository],
    });
    const users = npa.get(UserRepository);

    expect(users instanceof UserRepository).toEqual(true);
    expect(users.helperName()).toEqual("users");
    expect(await users.findById(1)).toEqual({ id: 1 });
    expect(created[0].entity).toEqual(TokenUser);
    expect(created[0].repository).toEqual(UserRepository);
  });

  test("rejects repositories without @Repository metadata", () => {
    abstract class MissingRepository extends NPARepository<TokenUser, number> {}

    const adapter = {
      createRepository() {
        return {};
      },
    } as unknown as NPARuntimeAdapter;

    expect(() => new NPA({ adapter, repositories: [MissingRepository] })).toThrow(/MissingRepository is missing @Repository\(Entity\)/);
  });

  test("keeps explicit repository lists scoped to the provided tokens", () => {
    abstract class OtherRepository extends NPARepository<TokenUser, number> {}
    Repository(TokenUser)(OtherRepository);

    const npa = new NPA({
      adapter: {
        createRepository(options: NPACreateRepositoryOptions) {
          return Object.create(options.repository.prototype);
        },
      } as unknown as NPARuntimeAdapter,
      repositories: [UserRepository],
    });

    expect(() => npa.get(OtherRepository)).toThrow(/OtherRepository was not registered in this NPA instance/);
  });

  test("createNPA remains a compatibility wrapper", () => {
    const npa = createNPA({
      adapter: {
        createRepository(options: NPACreateRepositoryOptions) {
          return Object.create(options.repository.prototype);
        },
      } as unknown as NPARuntimeAdapter,
      repositories: [UserRepository],
    });

    expect(npa.get(UserRepository) instanceof UserRepository).toEqual(true);
  });
});
