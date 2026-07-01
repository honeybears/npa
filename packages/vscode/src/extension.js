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
const NPA_DIAGNOSTIC_SOURCE = "npa";

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
    vscode.languages.registerCodeActionsProvider(
      DOCUMENT_SELECTOR,
      {
        async provideCodeActions(document, range, context) {
          return provideCodeActions(document, range, context);
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
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

  const replacementRange = new vscode.Range(
    document.positionAt(offset - prefix.length),
    position,
  );

  return getNPAQueryMethodCompletions({
    prefix,
    entity,
    workspace,
    includeOrderBy: true,
    limit: 80,
  }).map((completion) => toCompletionItem(completion, replacementRange));
}

function toCompletionItem(completion, replacementRange) {
  const item = new vscode.CompletionItem(
    completion.name,
    vscode.CompletionItemKind.Method,
  );
  item.insertText = new vscode.SnippetString(completion.insertText);
  item.range = replacementRange;
  item.filterText = completion.filterText ?? completion.name;
  item.detail = completion.signature ?? completion.detail;
  item.sortText = completion.sortText;

  const documentation = new vscode.MarkdownString();
  documentation.appendCodeblock(completion.signature ?? completion.name, "typescript");

  if (completion.documentation) {
    documentation.appendMarkdown(`
${completion.documentation}`);
  }

  item.documentation = documentation;
  return item;
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
      const vscodeDiagnostic = new vscode.Diagnostic(
        getDiagnosticRange(document, method, diagnostic),
        diagnostic.message,
        getDiagnosticSeverity(diagnostic),
      );
      vscodeDiagnostic.source = NPA_DIAGNOSTIC_SOURCE;
      vscodeDiagnostic.code = diagnostic.code;
      vscodeDiagnostics.push(vscodeDiagnostic);
    }
  }

  diagnostics.set(document.uri, vscodeDiagnostics);
}

async function provideCodeActions(document, range, context) {
  if (!isSupportedDocument(document) || !hasNPADiagnostic(context.diagnostics)) {
    return undefined;
  }

  const workspace = await collectWorkspaceSchema(document);
  const source = document.getText();
  const actions = [];

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
      const diagnosticRange = getDiagnosticRange(document, method, diagnostic);

      if (!rangesIntersect(range, diagnosticRange)) {
        continue;
      }

      for (const suggestion of diagnostic.suggestions ?? []) {
        actions.push(toCodeAction(document, method, diagnosticRange, suggestion));
      }
    }
  }

  return actions;
}

function toCodeAction(document, method, diagnosticRange, suggestion) {
  const action = new vscode.CodeAction(suggestion.title, vscode.CodeActionKind.QuickFix);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(method.start), document.positionAt(method.end)),
    suggestion.replacementMethodName,
  );
  action.edit = edit;
  action.isPreferred = true;
  action.diagnostics = [new vscode.Diagnostic(diagnosticRange, suggestion.title)];
  return action;
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

function getDiagnosticRange(document, method, diagnostic) {
  const rangeText = diagnostic.rangeText ??
    (diagnostic.property ? toMethodSegment(diagnostic.property) : undefined);

  if (rangeText) {
    const offset = method.methodName.indexOf(rangeText);

    if (offset >= 0) {
      const start = method.start + offset;
      return new vscode.Range(
        document.positionAt(start),
        document.positionAt(start + rangeText.length),
      );
    }
  }

  return new vscode.Range(
    document.positionAt(method.start),
    document.positionAt(method.end),
  );
}

function getDiagnosticSeverity(diagnostic) {
  return diagnostic.severity === "WARNING" ?
    vscode.DiagnosticSeverity.Warning :
    vscode.DiagnosticSeverity.Error;
}

function hasNPADiagnostic(diagnostics) {
  return diagnostics.some((diagnostic) => diagnostic.source === NPA_DIAGNOSTIC_SOURCE);
}

function rangesIntersect(left, right) {
  return left.start.isBeforeOrEqual(right.end) && right.start.isBeforeOrEqual(left.end);
}

function isSupportedDocument(document) {
  return document.languageId === "typescript" ||
    document.languageId === "typescriptreact";
}

function isQueryPrefix(prefix) {
  return /^(find|findOne|exists|count|delete)/.test(prefix);
}

function toMethodSegment(propertyName) {
  return propertyName.charAt(0).toUpperCase() + propertyName.slice(1);
}

module.exports = {
  activate,
  deactivate,
};
