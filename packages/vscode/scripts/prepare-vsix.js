const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const vendorNodeModules = path.join(packageRoot, "vendor", "node_modules");

function main() {
  const languageDist = path.join(repoRoot, "packages", "language", "dist");
  const queryMethodDist = path.join(repoRoot, "dist", "query-method");

  assertDirectory(languageDist, "Run npm run build before packaging the VS Code extension.");
  assertDirectory(queryMethodDist, "Run npm run build before packaging the VS Code extension.");

  fs.rmSync(path.join(packageRoot, "vendor"), { recursive: true, force: true });
  copyJavaScriptFiles(languageDist, path.join(vendorNodeModules, "@node-persistence-api", "language"));
  copyJavaScriptFiles(queryMethodDist, path.join(vendorNodeModules, "@node-persistence-api", "core", "query-method"));

  writePackageJson(path.join(vendorNodeModules, "@node-persistence-api", "language"), {
    name: "@node-persistence-api/language",
    main: "index.js",
  });
  writePackageJson(path.join(vendorNodeModules, "@node-persistence-api", "core"), {
    name: "@node-persistence-api/core",
    main: "index.js",
  });
}

function assertDirectory(directory, message) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${message} Missing directory: ${directory}`);
  }
}

function copyJavaScriptFiles(source, destination) {
  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyJavaScriptFiles(sourcePath, destinationPath);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".js")) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function writePackageJson(directory, contents) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(contents, null, 2)}\n`,
  );
}

main();
