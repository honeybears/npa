const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const manifest = require(path.join(packageRoot, "package.json"));

function getVsixPath() {
  return path.join(repoRoot, "dist", `${manifest.name}-${manifest.version}.vsix`);
}

module.exports = {
  getVsixPath,
  manifest,
  packageRoot,
  repoRoot,
};
