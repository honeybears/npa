import { NPALanguageEntityPropertyKind, NPALanguageEntityRelationKind, NPAQueryMethodDiagnosticCode, getNPAQueryMethodCompletions, parseNPAQueryMethodName, toNPALanguageEntitySchema, toNPALanguageWorkspaceSchema, validateNPAQueryMethod } from "../src";
import { MigrationRelationKind } from "@node-persistence-api/core";
import { parseQueryMethod } from "@node-persistence-api/core/query-method";
import { describe, expect, test } from "@jest/globals";

describe("language helpers", () => {
  test("reuses the core query method parser", () => {
    const methodName = "findTop5ByTeamNameAndAgeGreaterThanOrderByCreatedAtDesc";

    expect(parseNPAQueryMethodName(methodName)).toEqual(parseQueryMethod(methodName));
  });

  test("generates query method completions for direct and relation fields", () => {
    const workspace = createWorkspace();
    const user = workspace.entities.find((entity) => entity.className === "User");
    const completions = getNPAQueryMethodCompletions({
      prefix: "findByTeamNa",
      entity: user,
      workspace,
    });
    const names = completions.map((completion) => completion.name);

    for (const expected of [
      "findByTeamName",
      "findByTeamNameContaining",
      "findByTeamNameContainingIgnoreCase",
      "findByTeamNameEndingWith",
      "findByTeamNameIn",
      "findByTeamNameIsNotNull",
      "findByTeamNameIsNull",
      "findByTeamNameLike",
      "findByTeamNameNot",
      "findByTeamNameNotIn",
      "findByTeamNameStartingWith",
    ]) {
      expect(names.includes(expected)).toBeTruthy();
    }
  });

  test("generates query method completions for distinct, top, ignore-case, and compound order", () => {
    const workspace = createWorkspace();
    const user = workspace.entities.find((entity) => entity.className === "User");

    for (const expected of [
      ["findDistinctByNameContainingIg", "findDistinctByNameContainingIgnoreCase"],
      [
        "findDistinctTop10ByNameContainingIg",
        "findDistinctTop10ByNameContainingIgnoreCase",
      ],
      ["findFirstByNa", "findFirstByName"],
      ["findTopByNa", "findTopByName"],
      ["findTop10ByNa", "findTop10ByName"],
      ["findByNameAll", "findByNameAllIgnoreCase"],
      ["findByNameOrderByNameAscAge", "findByNameOrderByNameAscAgeDesc"],
    ]) {
      const names = getNPAQueryMethodCompletions({
        prefix: expected[0],
        entity: user,
        workspace,
        includeOrderBy: true,
        limit: 100,
      }).map((completion) => completion.name);

      expect(names.includes(expected[1])).toBeTruthy();
    }
  });

  test("adds signatures, snippets, return types, and ordered details to completions", () => {
    const workspace = createWorkspace();
    const user = workspace.entities.find((entity) => entity.className === "User");
    const completions = getNPAQueryMethodCompletions({
      prefix: "findByName",
      entity: user,
      workspace,
      includeOrderBy: true,
      limit: 10,
    });
    const exact = completions.find((completion) => completion.name === "findByName");
    const ordered = completions.find((completion) => completion.name === "findByNameOrderByAgeDesc");

    expect(exact).toBeTruthy();
    expect(exact.signature).toEqual("findByName(name: string): Promise<User[]>;");
    expect(exact.insertText).toEqual("findByName(${1:name}: string): Promise<User[]>;");
    expect(exact.returnType).toEqual("Promise<User[]>");
    expect(exact.parameters).toEqual([{ name: "name", type: "string" }]);
    expect(exact.documentation.includes("Runs a find query on name")).toBeTruthy();
    expect(ordered.sortText > exact.sortText).toBeTruthy();
  });

  test("generates query method completions after And and Or connectors", () => {
    const workspace = createWorkspace();
    const user = workspace.entities.find((entity) => entity.className === "User");

    const andCompletions = getNPAQueryMethodCompletions({
      prefix: "findByNameAndA",
      entity: user,
      workspace,
      includeOrderBy: true,
      limit: 100,
    });
    const andCompletion = andCompletions.find((completion) =>
      completion.name === "findByNameAndAge",
    );

    expect(andCompletion).toBeTruthy();
    expect(andCompletion.signature).toEqual("findByNameAndAge(name: string, age: number): Promise<User[]>;");
    expect(andCompletion.insertText).toEqual("findByNameAndAge(${1:name}: string, ${2:age}: number): Promise<User[]>;");

    const orNames = getNPAQueryMethodCompletions({
      prefix: "findByNameOrTeamNa",
      entity: user,
      workspace,
      includeOrderBy: true,
      limit: 100,
    }).map((completion) => completion.name);

    expect(orNames.includes("findByNameOrTeamName")).toBeTruthy();
    expect(orNames.includes("findByNameOrTeamNameContaining")).toBeTruthy();

    const countCompletion = getNPAQueryMethodCompletions({
      prefix: "countByNameOrA",
      entity: user,
      workspace,
      limit: 100,
    }).find((completion) => completion.name === "countByNameOrAgeGreaterThan");

    expect(countCompletion).toBeTruthy();
    expect(countCompletion.signature).toEqual("countByNameOrAgeGreaterThan(name: string, age: number): Promise<number>;");
  });

  test("rejects exact duplicate predicates while allowing different operators", () => {
    const workspace = createWorkspace();
    const user = workspace.entities.find((entity) => entity.className === "User");

    const duplicateAnd = validateNPAQueryMethod({
      methodName: "findByNameAndName",
      entity: user,
      workspace,
    }).diagnostics[0];

    expect(duplicateAnd.code).toEqual(NPAQueryMethodDiagnosticCode.DUPLICATE_PREDICATE);
    expect(duplicateAnd.rangeText).toEqual("AndName");

    const duplicateOr = validateNPAQueryMethod({
      methodName: "findByNameOrName",
      entity: user,
      workspace,
    }).diagnostics[0];

    expect(duplicateOr.code).toEqual(NPAQueryMethodDiagnosticCode.DUPLICATE_PREDICATE);
    expect(duplicateOr.rangeText).toEqual("OrName");

    expect(validateNPAQueryMethod({
        methodName: "findByNameOrNameContaining",
        entity: user,
        workspace,
      }).diagnostics).toEqual([]);

    const names = getNPAQueryMethodCompletions({
      prefix: "findByNameAndNa",
      entity: user,
      workspace,
      limit: 100,
    }).map((completion) => completion.name);

    expect(!names.includes("findByNameAndName")).toBeTruthy();
    expect(names.includes("findByNameAndNameContaining")).toBeTruthy();
  });

  test("supports ManyToOne relation object query methods", () => {
    const workspace = createWorkspace();
    const user = workspace.entities.find((entity) => entity.className === "User");
    const completions = getNPAQueryMethodCompletions({
      prefix: "findByTe",
      entity: user,
      workspace,
      limit: 100,
    });
    const exact = completions.find((completion) => completion.name === "findByTeam");
    const inCompletion = completions.find((completion) => completion.name === "findByTeamIn");

    expect(exact).toBeTruthy();
    expect(exact.signature).toEqual("findByTeam(team: Team): Promise<User[]>;");
    expect(exact.insertText).toEqual("findByTeam(${1:team}: Team): Promise<User[]>;");
    expect(exact.parameters).toEqual([{ name: "team", type: "Team" }]);

    expect(inCompletion).toBeTruthy();
    expect(inCompletion.signature).toEqual("findByTeamIn(teamValues: ReadonlyArray<Team>): Promise<User[]>;");

    expect(validateNPAQueryMethod({
        methodName: "findByTeam",
        entity: user,
        workspace,
      }).diagnostics).toEqual([]);

    expect(validateNPAQueryMethod({
        methodName: "findByTeamContaining",
        entity: user,
        workspace,
      }).diagnostics.map((diagnostic) => diagnostic.code)).toEqual([NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR]);
  });

  test("validates derived query methods against entity schema", () => {
    const workspace = createWorkspace();
    const user = workspace.entities.find((entity) => entity.className === "User");
    const result = validateNPAQueryMethod({
      methodName: "findByTeamNameAndAgeGreaterThanOrderByCreatedAtDesc",
      entity: user,
      workspace,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.parsed.parameterCount).toEqual(2);
  });

  test("reports unknown properties and unsupported operators", () => {
    const workspace = createWorkspace();
    const user = workspace.entities.find((entity) => entity.className === "User");

    const unknownProperty = validateNPAQueryMethod({
      methodName: "findByNaem",
      entity: user,
      workspace,
    }).diagnostics[0];

    expect(unknownProperty.code).toEqual(NPAQueryMethodDiagnosticCode.UNKNOWN_PROPERTY);
    expect(unknownProperty.rangeText).toEqual("Naem");
    expect(unknownProperty.suggestions).toEqual([
      {
        title: "Change to findByName",
        replacementMethodName: "findByName",
      },
    ]);

    const unsupportedOperator = validateNPAQueryMethod({
      methodName: "findByAgeContaining",
      entity: user,
      workspace,
    }).diagnostics[0];

    expect(unsupportedOperator.code).toEqual(NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR);
    expect(unsupportedOperator.rangeText).toEqual("Containing");
    expect(unsupportedOperator.suggestions).toEqual([
      {
        title: "Use equality query findByAge",
        replacementMethodName: "findByAge",
      },
    ]);

    const unsupportedIgnoreCase = validateNPAQueryMethod({
      methodName: "findByAgeIgnoreCase",
      entity: user,
      workspace,
    }).diagnostics[0];

    expect(unsupportedIgnoreCase.code).toEqual(NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR);
    expect(unsupportedIgnoreCase.rangeText).toEqual("IgnoreCase");
    expect(unsupportedIgnoreCase.suggestions).toEqual([
      {
        title: "Remove IgnoreCase",
        replacementMethodName: "findByAge",
      },
    ]);

    expect(validateNPAQueryMethod({
        methodName: "findByNameAndAgeAllIgnoreCase",
        entity: user,
        workspace,
      }).diagnostics.map((diagnostic) => diagnostic.code)).toEqual([NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR]);
  });

  test("converts migration entity schemas into language schemas", () => {
    const languageSchema = toNPALanguageEntitySchema({
      className: "User",
      filePath: "src/user.entity.ts",
      tableName: "users",
      columns: [
        {
          propertyName: "id",
          columnName: "id",
          tsType: "number",
          nullable: false,
          primary: true,
          version: false,
        },
        {
          propertyName: "name",
          columnName: "name",
          tsType: "string",
          nullable: false,
          primary: false,
          version: false,
        },
      ],
      indexes: [],
      relations: [
        {
          propertyName: "team",
          kind: MigrationRelationKind.MANY_TO_ONE,
          targetClassName: "Team",
        },
      ],
    });

    expect(languageSchema).toEqual({
      className: "User",
      properties: [
        {
          name: "id",
          kind: NPALanguageEntityPropertyKind.ID,
          type: "number",
          nullable: false,
        },
        {
          name: "name",
          kind: NPALanguageEntityPropertyKind.COLUMN,
          type: "string",
          nullable: false,
        },
        {
          name: "team",
          kind: NPALanguageEntityPropertyKind.RELATION,
          type: "Team",
          target: "Team",
          relationKind: NPALanguageEntityRelationKind.MANY_TO_ONE,
        },
      ],
    });
  });
});

function createWorkspace() {
  return toNPALanguageWorkspaceSchema([
    {
      className: "User",
      filePath: "src/user.entity.ts",
      tableName: "users",
      columns: [
        column("id", "number", true),
        column("name", "string"),
        column("age", "number"),
        column("createdAt", "Date"),
      ],
      indexes: [],
      relations: [
        {
          propertyName: "team",
          kind: MigrationRelationKind.MANY_TO_ONE,
          targetClassName: "Team",
        },
      ],
    },
    {
      className: "Team",
      filePath: "src/team.entity.ts",
      tableName: "teams",
      columns: [column("id", "number", true), column("name", "string")],
      indexes: [],
      relations: [],
    },
  ]);
}

function column(propertyName, tsType, primary = false) {
  return {
    propertyName,
    columnName: propertyName,
    tsType,
    nullable: false,
    primary,
    version: false,
  };
}
