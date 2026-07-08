import { describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Column, Entity, Id, NPARepository, Repository, createNPA, type NPACreateRepositoryOptions, type NPARuntimeAdapter } from "../src";

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
  test("creates an NPA instance without repository bootstrap imports", () => {
    ensureBuiltCore();

    const script = `
  (async () => {
    const api = await import("./dist/index.js");

    if ("NPA" in api) {
      throw new Error("NPA class should not be exported");
    }

    api.createNPA({
      adapter: {
        createRepository() {
          throw new Error("adapter should not be called");
        },
      },
    });
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
    expect(result.stderr).toEqual("");
  });

  test("lazily creates and caches repositories when repositories are omitted", async () => {
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

    const npa = createNPA({ adapter });
    const users = npa.get(AutoUserRepository);
    const cached = npa.get(AutoUserRepository);

    expect(users instanceof AutoUserRepository).toEqual(true);
    expect(cached).toEqual(users);
    expect(await users.findById(10)).toEqual({ id: 10 });
    expect(created).toEqual([AutoUserRepository]);
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

    const npa = createNPA({
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

    expect(() => createNPA({ adapter, repositories: [MissingRepository] })).toThrow(/MissingRepository is missing @Repository\(Entity\)/);
  });

  test("rejects lazy repositories without @Repository metadata", () => {
    abstract class MissingRepository extends NPARepository<TokenUser, number> {}

    const npa = createNPA({
      adapter: {
        createRepository() {
          return {};
        },
      } as unknown as NPARuntimeAdapter,
    });

    expect(() => npa.get(MissingRepository)).toThrow(/MissingRepository is missing @Repository\(Entity\)/);
  });

  test("keeps explicit repository lists scoped to the provided tokens", () => {
    abstract class OtherRepository extends NPARepository<TokenUser, number> {}
    Repository(TokenUser)(OtherRepository);

    const npa = createNPA({
      adapter: {
        createRepository(options: NPACreateRepositoryOptions) {
          return Object.create(options.repository.prototype);
        },
      } as unknown as NPARuntimeAdapter,
      repositories: [UserRepository],
    });

    expect(() => npa.get(OtherRepository)).toThrow(/OtherRepository was not registered in this NPA instance/);
  });

  test("createNPA creates an NPA application", () => {
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

function ensureBuiltCore(): void {
  if (fs.existsSync(path.resolve(__dirname, "..", "dist", "index.js"))) {
    return;
  }

  const result = spawnSync("npm", ["run", "build"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to build core for test.\n${result.stdout}${result.stderr}`);
  }
}
