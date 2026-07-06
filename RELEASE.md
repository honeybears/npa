# Release

This repository publishes npm runtime packages separately from the VS Code
extension and examples.

## Publishable Packages

- `@node-persistence-api/core`: core repository API and CLI.
- `@node-persistence-api/language`: editor-independent completion and diagnostics helpers.
- `@node-persistence-api/connector-pg`: PostgreSQL connector and `pg` driver dependency.
- `@node-persistence-api/connector-mysql`: MySQL connector and `mysql2` driver dependency.

Do not publish `examples/*` or `packages/vscode` to npm. The VS Code package is
distributed as a VSIX/Marketplace extension.

## GitHub Actions Tag Release

Runtime npm packages can be released by pushing an annotated Git tag after the
publishable package versions and `CHANGELOG.md` have been committed. The release
workflow runs on Node.js 26, verifies package versions against the tag, runs the
unit and database E2E suites, packs and inspects the npm tarballs, publishes the
runtime packages with the `beta` dist-tag, moves `latest` to the same version,
and creates a GitHub Release.

The workflow requires an npm publish token in the repository secret
`NPM_TOKEN`.

```bash
git tag -a v0.1.0-beta.2 -m "v0.1.0-beta.2"
git push origin v0.1.0-beta.2
```

## v0.1.0-beta.0 Checklist

Use `pnpm pack`, not `npm pack`, for workspace packages. `pnpm pack` rewrites
`workspace:^` dependencies in the packed manifest, which prevents consumers from
installing a tarball that still references a local workspace protocol.

```bash
npm whoami
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:e2e
pnpm run release:pack
pnpm run release:inspect
```

Inspecting the packed manifests should show `@node-persistence-api/core` dependencies as
normal semver ranges such as `^0.1.0-beta.0`, not `workspace:^`.

For the first public publish of scoped packages, npm requires public access to be
set explicitly. The package manifests include `publishConfig.access=public`, and
the commands below pass `--access public` as an extra guard.

```bash
npm publish .release/node-persistence-api-core-0.1.0-beta.0.tgz --access public --tag beta
npm publish .release/node-persistence-api-language-0.1.0-beta.0.tgz --access public --tag beta
npm publish .release/node-persistence-api-connector-pg-0.1.0-beta.0.tgz --access public --tag beta
npm publish .release/node-persistence-api-connector-mysql-0.1.0-beta.0.tgz --access public --tag beta
```

Publish order matters: core first, then language helpers, then database
connectors. After publishing, verify installs from a disposable project:

```bash
npm view @node-persistence-api/core version
npm view @node-persistence-api/connector-pg version
npm view @node-persistence-api/connector-mysql version
```

## Benchmark Note

The comparison benchmark is useful release evidence, but it should be framed as
a local sample for a specific schema, query mix, machine, Node version, and
PostgreSQL container. Keep benchmark claims near the reproduction command and
avoid presenting them as universal ORM rankings.

## VS Code Extension

The VS Code package is `packages/vscode`, with Marketplace extension id
`honeybeaers.npa` and display name `NPA`. It vendors the built language helper output into the
VSIX, so publish it after the core build succeeds.

For beta releases, publish the extension to the Marketplace pre-release channel:

```bash
pnpm run test:vscode
pnpm run package:vscode:pre
pnpm run verify:vscode-install
pnpm run verify:vscode-pat
VSCE_PAT=... pnpm run publish:vscode:pre
```

`verify:vscode-install` requires the `code` command to be available. If VS Code
is installed but the command is named differently, set `VSCODE_CLI=/path/to/code`.

For a stable Marketplace release, use:

```bash
pnpm run test:vscode
pnpm run package:vscode
pnpm run verify:vscode-install
pnpm run verify:vscode-pat
VSCE_PAT=... pnpm run publish:vscode
```

`vsce` also supports an interactive login flow:

```bash
pnpm --dir packages/vscode exec vsce login honeybeaers
```

The generated VSIX path is version-derived from `packages/vscode/package.json`,
for example `dist/npa-0.1.0.vsix`.
