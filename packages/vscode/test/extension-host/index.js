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

  const source = repositoryDocument.getText();
  const offset = source.indexOf("findByNa") + "findByNa".length;
  const position = repositoryDocument.positionAt(offset);
  const completionList = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    repositoryDocument.uri,
    position,
  );

  const labels = completionList.items.map((item) =>
    typeof item.label === "string" ? item.label : item.label.label,
  );
  assert.ok(labels.includes("findByName"), `expected findByName completion in ${labels.join(", ")}`);

  const diagnostics = await waitForDiagnostics(repositoryDocument.uri);
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.message.includes("IgnoreCase is only supported")),
    `expected IgnoreCase diagnostic, got ${diagnostics.map((item) => item.message).join(" | ")}`,
  );
}

async function waitForDiagnostics(uri) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const diagnostics = vscode.languages.getDiagnostics(uri);

    if (diagnostics.length > 0) {
      return diagnostics;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return vscode.languages.getDiagnostics(uri);
}

module.exports = { run };
