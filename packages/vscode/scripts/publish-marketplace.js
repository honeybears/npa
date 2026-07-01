const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const { getVsixPath, packageRoot } = require("./vsix");

const preRelease = process.argv.includes("--pre-release");
const vsixPath = getVsixPath();

run("node", ["scripts/package-vsix.js", ...(preRelease ? ["--pre-release"] : [])], packageRoot);

if (!fs.existsSync(vsixPath)) {
  console.error(`VSIX not found after packaging: ${vsixPath}`);
  process.exit(1);
}

const args = [
  "exec",
  "vsce",
  "publish",
  "--packagePath",
  vsixPath,
];

if (preRelease) {
  args.push("--pre-release");
}

run("pnpm", args, packageRoot);

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
