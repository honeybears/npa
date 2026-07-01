const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const { getVsixPath, packageRoot, repoRoot } = require("./vsix");

const preRelease = process.argv.includes("--pre-release");
const vsixPath = getVsixPath();

run("npm", ["run", "build"], repoRoot);
run("node", ["scripts/prepare-vsix.js"], packageRoot);

fs.mkdirSync(`${repoRoot}/dist`, { recursive: true });

const args = [
  "exec",
  "vsce",
  "package",
  "--no-dependencies",
  "--allow-missing-repository",
  "--out",
  vsixPath,
];

if (preRelease) {
  args.push("--pre-release");
}

run("pnpm", args, packageRoot);
console.log(`Packaged ${preRelease ? "pre-release " : ""}VSIX: ${vsixPath}`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
