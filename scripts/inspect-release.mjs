#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, '.release');
const expectedPackages = new Set([
  '@node-persistence-api/core',
  '@node-persistence-api/language',
  '@node-persistence-api/connector-pg',
  '@node-persistence-api/connector-mysql',
]);

function fail(message) {
  console.error(`release inspect failed: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(releaseDir)) {
  fail('missing .release directory; run pnpm run release:pack first');
  process.exit();
}

const tarballs = readdirSync(releaseDir)
  .filter((entry) => entry.endsWith('.tgz'))
  .sort();

if (tarballs.length === 0) {
  fail('no .tgz files found in .release');
  process.exit();
}

const seenPackages = new Set();

for (const tarball of tarballs) {
  const tarballPath = path.join(releaseDir, tarball);
  const manifestText = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
  });
  const manifest = JSON.parse(manifestText);
  seenPackages.add(manifest.name);

  if (manifestText.includes('workspace:')) {
    fail(`${tarball} still contains a workspace: dependency`);
  }

  if (expectedPackages.has(manifest.name) && manifest.publishConfig?.access !== 'public') {
    fail(`${manifest.name} is missing publishConfig.access=public`);
  }

  const deps = Object.entries(manifest.dependencies ?? {})
    .map(([name, version]) => `${name}@${version}`)
    .join(', ');
  console.log(`${manifest.name}@${manifest.version} ${tarball}${deps ? ` deps=[${deps}]` : ''}`);
}

for (const packageName of expectedPackages) {
  if (!seenPackages.has(packageName)) {
    fail(`missing tarball for ${packageName}`);
  }
}
