const assert = require("node:assert/strict");
const test = require("node:test");

const {
  NPALanguageEntityPropertyKind,
  NPAQueryMethodDiagnosticCode,
  getNPAQueryMethodCompletions,
  parseNPAQueryMethodName,
  toNPALanguageEntitySchema,
  toNPALanguageWorkspaceSchema,
  validateNPAQueryMethod,
} = require("../dist");
const { parseQueryMethod } = require("@honeybeaers/npa/query-method");

test("reuses the core query method parser", () => {
  const methodName = "findTop5ByTeamNameAndAgeGreaterThanOrderByCreatedAtDesc";

  assert.deepEqual(
    parseNPAQueryMethodName(methodName),
    parseQueryMethod(methodName),
  );
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
    assert.ok(names.includes(expected), `Missing completion ${expected}`);
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

    assert.ok(names.includes(expected[1]), `Missing completion ${expected[1]}`);
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

  assert.ok(exact, "expected findByName completion");
  assert.equal(exact.signature, "findByName(name: string): Promise<User[]>;");
  assert.equal(exact.insertText, "findByName(${1:name}: string): Promise<User[]>;");
  assert.equal(exact.returnType, "Promise<User[]>");
  assert.deepEqual(exact.parameters, [{ name: "name", type: "string" }]);
  assert.ok(exact.documentation.includes("Runs a find query on name"));
  assert.ok(ordered.sortText > exact.sortText, "plain query should sort before OrderBy variants");
});

test("validates derived query methods against entity schema", () => {
  const workspace = createWorkspace();
  const user = workspace.entities.find((entity) => entity.className === "User");
  const result = validateNPAQueryMethod({
    methodName: "findByTeamNameAndAgeGreaterThanOrderByCreatedAtDesc",
    entity: user,
    workspace,
  });

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.parsed.parameterCount, 2);
});

test("reports unknown properties and unsupported operators", () => {
  const workspace = createWorkspace();
  const user = workspace.entities.find((entity) => entity.className === "User");

  const unknownProperty = validateNPAQueryMethod({
    methodName: "findByNaem",
    entity: user,
    workspace,
  }).diagnostics[0];

  assert.equal(unknownProperty.code, NPAQueryMethodDiagnosticCode.UNKNOWN_PROPERTY);
  assert.equal(unknownProperty.rangeText, "Naem");
  assert.deepEqual(unknownProperty.suggestions, [
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

  assert.equal(unsupportedOperator.code, NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR);
  assert.equal(unsupportedOperator.rangeText, "Containing");
  assert.deepEqual(unsupportedOperator.suggestions, [
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

  assert.equal(unsupportedIgnoreCase.code, NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR);
  assert.equal(unsupportedIgnoreCase.rangeText, "IgnoreCase");
  assert.deepEqual(unsupportedIgnoreCase.suggestions, [
    {
      title: "Remove IgnoreCase",
      replacementMethodName: "findByAge",
    },
  ]);

  assert.deepEqual(
    validateNPAQueryMethod({
      methodName: "findByNameAndAgeAllIgnoreCase",
      entity: user,
      workspace,
    }).diagnostics.map((diagnostic) => diagnostic.code),
    [NPAQueryMethodDiagnosticCode.UNSUPPORTED_OPERATOR],
  );
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
        kind: "MANY_TO_ONE",
        targetClassName: "Team",
      },
    ],
  });

  assert.deepEqual(languageSchema, {
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
        target: "Team",
      },
    ],
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
          kind: "MANY_TO_ONE",
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
