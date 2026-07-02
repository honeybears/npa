import { describe, expect, test } from "@jest/globals";
import { collectLanguageWorkspaceSchemaFromSources, findQueryDecoratorDiagnostics, findQueryParameterCompletionContext, findRepositoryContext, findRepositoryMethodDeclarations, getMethodPrefixAtOffset, parseEntitySchemasFromText } from "../src/npa-vscode-core";
describe("VS Code language core", () => {
  test("parses NPA entity source into language schemas", () => {
    expect(parseEntitySchemasFromText(`
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
    `)).toEqual([
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

    expect(findRepositoryContext(source, offset)).toEqual({
      repositoryName: "UserRepository",
      entityName: "User",
      bodyStart: source.indexOf("{"),
      bodyEnd: source.lastIndexOf("}"),
    });
    expect(getMethodPrefixAtOffset(source, offset)).toEqual("findByNa");
  });

  test("finds declared query methods for diagnostics", () => {
    const source = `
      interface UserRepository extends NPARepository<User, number> {
        findByName(name: string): Promise<User[]>;
        existsByMissing(value: string): Promise<boolean>;
      }
    `;
    const methods = findRepositoryMethodDeclarations(source);

    expect(methods.map((method) => ({
        repositoryName: method.repositoryName,
        entityName: method.entityName,
        methodName: method.methodName,
        text: source.slice(method.start, method.end),
      }))).toEqual([
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
      ]);
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

    expect(context).toBeTruthy();
    expect(context.methodName).toEqual("findByEmailSql");
    expect(context.prefix).toEqual("em");
    expect(context.replacementStart).toEqual(source.indexOf(":em") + 1);
    expect(context.replacementEnd).toEqual(offset);
    expect(context.parameters).toEqual([
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

    expect(diagnostics.length).toEqual(1);
    expect(diagnostics[0].code).toEqual("npa-query-function-property");
    expect(diagnostics[0].methodName).toEqual("findByNameSql");
    expect(source.slice(diagnostics[0].start, diagnostics[0].end)).toEqual("findByNameSql");
    expect(findRepositoryMethodDeclarations(source)).toEqual([]);
  });

  test("collects workspace schema from multiple source files", () => {
    expect(collectLanguageWorkspaceSchemaFromSources([
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
    ])).toEqual({
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
});
