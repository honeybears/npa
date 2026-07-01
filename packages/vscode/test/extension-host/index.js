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

  const extension = vscode.extensions.getExtension("honeybeaers.npa-vscode");
  assert.ok(extension, "expected NPA extension to be available");
  await extension.activate();

  await assertCompletion(repositoryDocument);
  await assertDiagnosticsAndQuickFix(repositoryDocument);
}

async function assertCompletion(repositoryDocument) {
  const source = repositoryDocument.getText();
  const offset = source.indexOf("findByNa") + "findByNa".length;
  const position = repositoryDocument.positionAt(offset);
  const completionList = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    repositoryDocument.uri,
    position,
  );

  const completion = completionList.items.find((item) => getLabel(item) === "findByName");
  const labels = completionList.items.map(getLabel);
  assert.ok(completion, `expected findByName completion in ${labels.join(", ")}`);
  assert.equal(
    completion.insertText.value,
    "findByName(${1:name}: string): Promise<User[]>;",
  );
  assert.equal(completion.detail, "findByName(name: string): Promise<User[]>;");
  assert.ok(completion.documentation.value.includes("Runs a find query on name"));
}

async function assertDiagnosticsAndQuickFix(repositoryDocument) {
  const diagnostics = await waitForDiagnostics(repositoryDocument.uri, 2);
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.message.includes("IgnoreCase is only supported")),
    `expected IgnoreCase diagnostic, got ${diagnostics.map((item) => item.message).join(" | ")}`,
  );

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
