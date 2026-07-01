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

  assert.deepEqual(
    completions.map((completion) => completion.name),
    [
      "findByTeamName",
      "findByTeamNameContaining",
      "findByTeamNameEndingWith",
      "findByTeamNameIn",
      "findByTeamNameIsNotNull",
      "findByTeamNameIsNull",
      "findByTeamNameLike",
      "findByTeamNameNot",
      "findByTeamNameNotIn",
      "findByTeamNameStartingWith",
    ],
  );
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

  assert.deepEqual(
    validateNPAQueryMethod({
      methodName: "findByMissing",
      entity: user,
      workspace,
    }).diagnostics.map((diagnostic) => diagnostic.code),
    [NPAQueryMethodDiagnosticCode.UNKNOWN_PROPERTY],
  );

  assert.deepEqual(
    validateNPAQueryMethod({
      methodName: "findByAgeContaining",
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
