const assert = require("node:assert/strict");
const test = require("node:test");

const {
  collectLanguageWorkspaceSchemaFromSources,
  findQueryDecoratorDiagnostics,
  findQueryParameterCompletionContext,
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



test("finds @Query parameter completion context inside SQL strings", () => {
  const source = `
    export abstract class UserRepository extends NPARepository<User, number> {
      @Query('SELECT * FROM users WHERE email = :em')
      findByEmailSql!: (email: string, active: boolean) => Promise<User | null>;
    }
  `;
  const offset = source.indexOf(":em") + ":em".length;
  const context = findQueryParameterCompletionContext(source, offset);

  assert.ok(context, "expected @Query parameter completion context");
  assert.equal(context.methodName, "findByEmailSql");
  assert.equal(context.prefix, "em");
  assert.equal(context.replacementStart, source.indexOf(":em") + 1);
  assert.equal(context.replacementEnd, offset);
  assert.deepEqual(context.parameters, [
    { name: "email", type: "string" },
    { name: "active", type: "boolean" },
  ]);
});

test("diagnoses @Query members that are not function properties", () => {
  const source = `
    export abstract class UserRepository extends NPARepository<User, number> {
      @Query('SELECT * FROM users WHERE email = :email')
      findByEmailSql!: (email: string) => Promise<User | null>;

      @Query('SELECT * FROM users WHERE name = :name')
      findByNameSql(name: string): Promise<User[]> {
        throw new Error('NPA provides the implementation');
      }
    }
  `;
  const diagnostics = findQueryDecoratorDiagnostics(source);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "npa-query-function-property");
  assert.equal(diagnostics[0].methodName, "findByNameSql");
  assert.equal(source.slice(diagnostics[0].start, diagnostics[0].end), "findByNameSql");
  assert.deepEqual(findRepositoryMethodDeclarations(source), []);
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
