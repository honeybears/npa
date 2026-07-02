async function main() {
  const path = await import("node:path");
  const testElectron = await import("@vscode/test-electron");
  const runTests = testElectron.runTests ?? testElectron.default?.runTests;

  if (!runTests) {
    throw new Error("Unable to load @vscode/test-electron runTests");
  }

  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "extension-host", "index.js");
  const workspacePath = path.resolve(__dirname, "fixtures", "workspace");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, "--disable-extensions"],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
