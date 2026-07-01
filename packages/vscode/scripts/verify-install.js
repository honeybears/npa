const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const { getVsixPath } = require("./vsix");

const vsixPath = path.resolve(packageRoot, process.argv[2] ?? getVsixPath());
const codeCommand = process.env.VSCODE_CLI || "code";
const tmpRoot = path.join(packageRoot, ".tmp", "install-check");
const extensionsDir = path.join(tmpRoot, "extensions");
const userDataDir = path.join(tmpRoot, "user-data");

if (!fs.existsSync(vsixPath)) {
  fail(`VSIX not found: ${vsixPath}`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(extensionsDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });

runCode([
  "--user-data-dir", userDataDir,
  "--extensions-dir", extensionsDir,
  "--install-extension", vsixPath,
  "--force",
]);

const installed = runCode([
  "--user-data-dir", userDataDir,
  "--extensions-dir", extensionsDir,
  "--list-extensions",
]);

if (!installed.stdout.split(/\r?\n/).includes("honeybeaers.npa-vscode")) {
  fail(`Extension was not listed after install. Output:\n${installed.stdout}`);
}

console.log(`Installed honeybeaers.npa-vscode from ${vsixPath}`);

function runCode(args) {
  const result = spawnSync(codeCommand, args, { encoding: "utf8" });

  if (result.error?.code === "ENOENT") {
    fail(`VS Code CLI not found: ${codeCommand}. Set VSCODE_CLI=/path/to/code or install the code command.`);
  }

  if (result.status !== 0) {
    fail([result.stdout, result.stderr].filter(Boolean).join("\n"));
  }

  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
