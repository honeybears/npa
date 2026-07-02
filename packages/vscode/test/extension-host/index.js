const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

async function run() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "expected a workspace folder");

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const entityUri = vscode.Uri.file(path.join(workspaceRoot, "src", "user.entity.ts"));
  const repositoryUri = vscode.Uri.file(path.join(workspaceRoot, "src", "user.repository.ts"));

  await vscode.workspace.openTextDocument(entityUri);
  const repositoryDocument = await vscode.workspace.openTextDocument(repositoryUri);
  await vscode.window.showTextDocument(repositoryDocument);

  const extension = vscode.extensions.getExtension("honeybeaers.npa");
  assert.ok(extension, "expected NPA extension to be available");
  await extension.activate();

  await assertCompletion(repositoryDocument);
  await assertDiagnosticsAndQuickFix(repositoryDocument);
}

async function assertCompletion(repositoryDocument) {
  const baseCompletion = await getCompletion(repositoryDocument, "findByNa", "findByName");
  assert.equal(
    baseCompletion.insertText.value,
    "findByName(${1:name}: string): Promise<User[]>;",
  );
  assert.equal(baseCompletion.detail, "findByName(name: string): Promise<User[]>;");
  assert.ok(baseCompletion.documentation.value.includes("Runs a find query on name"));

  const relationCompletion = await getCompletion(repositoryDocument, "findByTe", "findByTeam");
  assert.equal(
    relationCompletion.insertText.value,
    "findByTeam(${1:team}: Team): Promise<User[]>;",
  );
  assert.equal(
    relationCompletion.detail,
    "findByTeam(team: Team): Promise<User[]>;",
  );

  const compoundCompletion = await getCompletion(
    repositoryDocument,
    "findByNameAndA",
    "findByNameAndAge",
  );
  assert.equal(
    compoundCompletion.insertText.value,
    "findByNameAndAge(${1:name}: string, ${2:age}: number): Promise<User[]>;",
  );
  assert.equal(
    compoundCompletion.detail,
    "findByNameAndAge(name: string, age: number): Promise<User[]>;",
  );

  const queryParameterCompletion = await getCompletion(repositoryDocument, ":em", "email");
  assert.equal(queryParameterCompletion.insertText, "email");
  assert.equal(queryParameterCompletion.detail, "email: string");
}

async function getCompletion(repositoryDocument, prefix, expectedLabel) {
  const source = repositoryDocument.getText();
  const offset = source.indexOf(prefix) + prefix.length;
  const position = repositoryDocument.positionAt(offset);
  const completionList = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    repositoryDocument.uri,
    position,
  );

  const completion = completionList.items.find((item) => getLabel(item) === expectedLabel);
  const labels = completionList.items.map(getLabel);
  assert.ok(completion, `expected ${expectedLabel} completion in ${labels.join(", ")}`);
  return completion;
}

async function assertDiagnosticsAndQuickFix(repositoryDocument) {
  const diagnostics = await waitForDiagnostics(repositoryDocument.uri, 4);

  const queryDiagnostic = diagnostics.find((diagnostic) =>
    diagnostic.message.includes("@Query methods must be declared as a decorated function property"),
  );
  assert.ok(queryDiagnostic, "expected function property diagnostic for @Query");
  assert.equal(repositoryDocument.getText(queryDiagnostic.range), "findByNameSql");

  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.message.includes("IgnoreCase is only supported")),
    `expected IgnoreCase diagnostic, got ${diagnostics.map((item) => item.message).join(" | ")}`,
  );

  const duplicateDiagnostic = diagnostics.find((diagnostic) =>
    diagnostic.message.includes('Duplicate query predicate "name"'),
  );
  assert.ok(duplicateDiagnostic, "expected duplicate predicate diagnostic for findByNameOrName");
  assert.equal(repositoryDocument.getText(duplicateDiagnostic.range), "OrName");

  const typoDiagnostic = diagnostics.find((diagnostic) =>
    diagnostic.message.includes('Unknown query property "naem"'),
  );
  assert.ok(typoDiagnostic, "expected unknown property diagnostic for findByNaem");
  assert.equal(repositoryDocument.getText(typoDiagnostic.range), "Naem");

  const codeActions = await vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider",
    repositoryDocument.uri,
    typoDiagnostic.range,
    vscode.CodeActionKind.QuickFix.value,
  );
  const action = codeActions.find((item) => item.title === "Change to findByName");
  assert.ok(action, `expected Change to findByName quick fix in ${codeActions.map((item) => item.title).join(", ")}`);
}

function getLabel(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

async function waitForDiagnostics(uri, minimumCount) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const diagnostics = vscode.languages.getDiagnostics(uri);

    if (diagnostics.length >= minimumCount) {
      return diagnostics;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return vscode.languages.getDiagnostics(uri);
}

module.exports = { run };
