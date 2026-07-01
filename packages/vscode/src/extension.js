const vscode = require("vscode");
const {
  getNPAQueryMethodCompletions,
  validateNPAQueryMethod,
} = loadNPALanguage();
const {
  collectLanguageWorkspaceSchemaFromSources,
  findRepositoryContext,
  findRepositoryMethodDeclarations,
  getMethodPrefixAtOffset,
  isEntityFile,
} = require("./npa-vscode-core");

const DOCUMENT_SELECTOR = [
  { language: "typescript", scheme: "file" },
  { language: "typescriptreact", scheme: "file" },
];

async function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection("npa");

  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerCompletionItemProvider(
      DOCUMENT_SELECTOR,
      {
        async provideCompletionItems(document, position) {
          return provideCompletionItems(document, position);
        },
      },
    ),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void refreshDiagnostics(document, diagnostics);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      void refreshDiagnostics(event.document, diagnostics);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void refreshDiagnostics(document, diagnostics);
    }),
  );

  await Promise.all(
    vscode.workspace.textDocuments.map((document) =>
      refreshDiagnostics(document, diagnostics),
    ),
  );
}

function deactivate() {}

function loadNPALanguage() {
  try {
    return require("@honeybeaers/npa-language");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND" ||
      !String(error.message).includes("@honeybeaers/npa-language")) {
      throw error;
    }

    return require("../vendor/node_modules/@honeybeaers/npa-language");
  }
}

async function provideCompletionItems(document, position) {
  if (!isSupportedDocument(document)) {
    return undefined;
  }

  const source = document.getText();
  const offset = document.offsetAt(position);
  const repository = findRepositoryContext(source, offset);
  const prefix = getMethodPrefixAtOffset(source, offset);

  if (!repository || !isQueryPrefix(prefix)) {
    return undefined;
  }

  const workspace = await collectWorkspaceSchema(document);
  const entity = workspace.entities.find((item) =>
    item.className === repository.entityName,
  );

  if (!entity) {
    return undefined;
  }

  return getNPAQueryMethodCompletions({
    prefix,
    entity,
    workspace,
    includeOrderBy: true,
    limit: 80,
  }).map((completion) => {
    const item = new vscode.CompletionItem(
      completion.name,
      vscode.CompletionItemKind.Method,
    );
    item.insertText = completion.insertText;
    item.detail = completion.detail;
    item.sortText = completion.sortText;
    return item;
  });
}

async function refreshDiagnostics(document, diagnostics) {
  if (!isSupportedDocument(document)) {
    return;
  }

  const workspace = await collectWorkspaceSchema(document);
  const source = document.getText();
  const vscodeDiagnostics = [];

  for (const method of findRepositoryMethodDeclarations(source)) {
    const entity = workspace.entities.find((item) =>
      item.className === method.entityName,
    );

    if (!entity) {
      continue;
    }

    const result = validateNPAQueryMethod({
      methodName: method.methodName,
      entity,
      workspace,
    });

    for (const diagnostic of result.diagnostics) {
      vscodeDiagnostics.push(new vscode.Diagnostic(
        new vscode.Range(
          document.positionAt(method.start),
          document.positionAt(method.end),
        ),
        diagnostic.message,
        vscode.DiagnosticSeverity.Error,
      ));
    }
  }

  diagnostics.set(document.uri, vscodeDiagnostics);
}

async function collectWorkspaceSchema(seedDocument) {
  const sources = [];
  const seen = new Set();

  for (const document of vscode.workspace.textDocuments) {
    if (isSupportedDocument(document) && isEntityFile(document.fileName)) {
      sources.push({ filePath: document.fileName, text: document.getText() });
      seen.add(document.uri.toString());
    }
  }

  if (isSupportedDocument(seedDocument) && !seen.has(seedDocument.uri.toString())) {
    sources.push({ filePath: seedDocument.fileName, text: seedDocument.getText() });
    seen.add(seedDocument.uri.toString());
  }

  const files = await vscode.workspace.findFiles(
    "**/*.entity.{ts,tsx}",
    "**/{node_modules,dist}/**",
    2000,
  );

  for (const uri of files) {
    if (seen.has(uri.toString())) {
      continue;
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    sources.push({
      filePath: uri.fsPath,
      text: Buffer.from(bytes).toString("utf8"),
    });
  }

  return collectLanguageWorkspaceSchemaFromSources(sources);
}

function isSupportedDocument(document) {
  return document.languageId === "typescript" ||
    document.languageId === "typescriptreact";
}

function isQueryPrefix(prefix) {
  return /^(find|findOne|exists|count|delete)/.test(prefix);
}

module.exports = {
  activate,
  deactivate,
};
