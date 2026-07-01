import { NPAMigrationRelationKind } from "@honeybeaers/npa";
import {
  getNPAQueryMethodCompletions,
  toNPALanguageWorkspaceSchema,
  validateNPAQueryMethod,
} from "@honeybeaers/npa-language";

const workspace = toNPALanguageWorkspaceSchema([
  {
    className: "User",
    filePath: "src/user.repository.ts",
    tableName: "users",
    columns: [
      column("id", "number", true),
      column("name", "string"),
      column("email", "string"),
      column("age", "number"),
      column("createdAt", "Date"),
    ],
    indexes: [],
    relations: [
      {
        propertyName: "team",
        kind: NPAMigrationRelationKind.MANY_TO_ONE,
        targetClassName: "Team",
      },
    ],
  },
  {
    className: "Team",
    filePath: "src/user.repository.ts",
    tableName: "teams",
    columns: [column("id", "number", true), column("name", "string")],
    indexes: [],
    relations: [],
  },
]);

const user = workspace.entities.find((entity) => entity.className === "User");

if (!user) {
  throw new Error("User schema was not created.");
}

const completions = getNPAQueryMethodCompletions({
  prefix: "findDistinctTop10ByNameContainingIg",
  entity: user,
  workspace,
  includeOrderBy: true,
  limit: 10,
});

console.log("Completion candidates");
console.log(completions.map((completion) => completion.name));

const valid = validateNPAQueryMethod({
  methodName: "findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc",
  entity: user,
  workspace,
});

console.log("Valid method diagnostics");
console.log(valid.diagnostics);

const invalid = validateNPAQueryMethod({
  methodName: "findByAgeIgnoreCase",
  entity: user,
  workspace,
});

console.log("Invalid method diagnostics");
console.log(invalid.diagnostics);

function column(propertyName: string, tsType: string, primary = false) {
  return {
    propertyName,
    columnName: propertyName,
    tsType,
    nullable: false,
    primary,
    version: false,
  };
}
