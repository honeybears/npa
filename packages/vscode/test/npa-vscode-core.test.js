const assert = require("node:assert/strict");
const test = require("node:test");

const {
  collectLanguageWorkspaceSchemaFromSources,
  findRepositoryContext,
  findRepositoryMethodDeclarations,
  getMethodPrefixAtOffset,
  parseEntitySchemasFromText,
} = require("../src/npa-vscode-core");

test("parses NPA entity source into language schemas", () => {
  assert.deepEqual(parseEntitySchemasFromText(`
    @Entity({ name: "users" })
    export class User {
      @Id()
      id?: number;

      @Column()
      name!: string;

      @Column()
      createdAt!: Date;

      @ManyToOne(() => Team)
      team?: Team;
    }
  `), [
    {
      className: "User",
      filePath: "",
      properties: [
        { name: "id", kind: "ID", type: "number" },
        { name: "name", kind: "COLUMN", type: "string" },
        { name: "createdAt", kind: "COLUMN", type: "Date" },
        { name: "team", kind: "RELATION", type: "Team", target: "Team", relationKind: "MANY_TO_ONE" },
      ],
    },
  ]);
});

test("finds repository context and typed method prefix at cursor", () => {
  const source = `
    export abstract class UserRepository extends NPARepository<User, number> {
      abstract findByNa
    }
  `;
  const offset = source.indexOf("findByNa") + "findByNa".length;

  assert.deepEqual(findRepositoryContext(source, offset), {
    repositoryName: "UserRepository",
    entityName: "User",
    bodyStart: source.indexOf("{"),
    bodyEnd: source.lastIndexOf("}"),
  });
  assert.equal(getMethodPrefixAtOffset(source, offset), "findByNa");
});

test("finds declared query methods for diagnostics", () => {
  const source = `
    interface UserRepository extends NPARepository<User, number> {
      findByName(name: string): Promise<User[]>;
      existsByMissing(value: string): Promise<boolean>;
    }
  `;
  const methods = findRepositoryMethodDeclarations(source);

  assert.deepEqual(
    methods.map((method) => ({
      repositoryName: method.repositoryName,
      entityName: method.entityName,
      methodName: method.methodName,
      text: source.slice(method.start, method.end),
    })),
    [
      {
        repositoryName: "UserRepository",
        entityName: "User",
        methodName: "findByName",
        text: "findByName",
      },
      {
        repositoryName: "UserRepository",
        entityName: "User",
        methodName: "existsByMissing",
        text: "existsByMissing",
      },
    ],
  );
});

test("collects workspace schema from multiple source files", () => {
  assert.deepEqual(collectLanguageWorkspaceSchemaFromSources([
    {
      filePath: "src/user.entity.ts",
      text: `
        @Entity()
        export class User {
          @Id()
          id!: number;

          @Column()
          name!: string;
        }
      `,
    },
    {
      filePath: "src/team.entity.ts",
      text: `
        @Entity()
        export class Team {
          @Id()
          id!: number;
        }
      `,
    },
  ]), {
    entities: [
      {
        className: "User",
        filePath: "src/user.entity.ts",
        properties: [
          { name: "id", kind: "ID", type: "number" },
          { name: "name", kind: "COLUMN", type: "string" },
        ],
      },
      {
        className: "Team",
        filePath: "src/team.entity.ts",
        properties: [{ name: "id", kind: "ID", type: "number" }],
      },
    ],
  });
});
