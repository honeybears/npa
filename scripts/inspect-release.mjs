#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
const packageVersions = new Set();
const packedPackages = [];

for (const tarball of tarballs) {
  const tarballPath = path.join(releaseDir, tarball);
  const manifestText = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  const manifest = JSON.parse(manifestText);
  seenPackages.add(manifest.name);
  packageVersions.add(manifest.version);
  packedPackages.push({ manifest, tarballPath });

  if (manifestText.includes('workspace:')) {
    fail(`${tarball} still contains a workspace: dependency`);
  }

  if (expectedPackages.has(manifest.name) && manifest.publishConfig?.access !== 'public') {
    fail(`${manifest.name} is missing publishConfig.access=public`);
  }

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (
      target &&
      typeof target === 'object' &&
      'require' in target &&
      !('import' in target || 'default' in target)
    ) {
      fail(`${manifest.name} export ${subpath} supports require but not import`);
    }
  }

  const contents = execFileSync('tar', ['-tzf', tarballPath], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (!contents.split('\n').some((entry) => /^package\/license(?:\.txt)?$/i.test(entry))) {
    fail(`${manifest.name} tarball is missing a LICENSE file`);
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

if (packageVersions.size > 1) {
  fail(`runtime package versions do not match: ${[...packageVersions].join(', ')}`);
}

if ([...expectedPackages].every((packageName) => seenPackages.has(packageName))) {
  inspectRuntimeConsumption(packedPackages);
}

function inspectRuntimeConsumption(packages) {
  const installRoot = mkdtempSync(path.join(tmpdir(), 'npa-release-inspect-'));
  const nodeModules = path.join(installRoot, 'node_modules');

  try {
    for (const { manifest, tarballPath } of packages) {
      if (!expectedPackages.has(manifest.name)) {
        continue;
      }

      const packageDir = path.join(nodeModules, ...manifest.name.split('/'));
      mkdirSync(packageDir, { recursive: true });
      execFileSync(
        'tar',
        ['-xzf', tarballPath, '-C', packageDir, '--strip-components=1'],
        { env: { ...process.env, LC_ALL: 'C' }, stdio: 'pipe' },
      );
    }

    linkRuntimeDependency(nodeModules, 'pg');
    linkRuntimeDependency(nodeModules, 'mysql2');

    const specifiers = [
      '@node-persistence-api/core',
      '@node-persistence-api/core/query-method',
      '@node-persistence-api/core/adapter',
      '@node-persistence-api/language',
      '@node-persistence-api/connector-pg',
      '@node-persistence-api/connector-mysql',
    ];
    const requireScript = specifiers
      .map((specifier) => `require(${JSON.stringify(specifier)})`)
      .join(';');
    const importScript = [
      "import { Entity } from '@node-persistence-api/core';",
      "import { parseQueryMethod } from '@node-persistence-api/core/query-method';",
      "import { createNPA } from '@node-persistence-api/core/adapter';",
      "import { getNPAQueryMethodCompletions } from '@node-persistence-api/language';",
      "import { postgresql } from '@node-persistence-api/connector-pg';",
      "import { mysql } from '@node-persistence-api/connector-mysql';",
      "if (![Entity, parseQueryMethod, createNPA, getNPAQueryMethodCompletions, postgresql, mysql].every((value) => typeof value === 'function')) process.exit(1);",
    ].join('\n');

    execFileSync(process.execPath, ['-e', requireScript], {
      cwd: installRoot,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, ['--input-type=module', '-e', importScript], {
      cwd: installRoot,
      stdio: 'pipe',
    });
    console.log('runtime smoke: CommonJS require and ESM import passed');
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    fail(`runtime smoke failed${stderr ? `: ${stderr}` : ''}`);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
}

function linkRuntimeDependency(nodeModules, dependency) {
  const source = path.join(root, 'node_modules', dependency);

  if (!existsSync(source)) {
    return;
  }

  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(realpathSync(source), path.join(nodeModules, dependency), 'dir');
}
