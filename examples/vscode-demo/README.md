# NPA VS Code Demo

This example uses local workspace dependencies for `@node-persistence-api/core` and
`@node-persistence-api/language`.

Run the language-helper demo:

```bash
pnpm --filter npa-example-vscode-demo demo
```

Open the sample project with the local extension in development mode:

```bash
code --extensionDevelopmentPath=packages/vscode examples/vscode-demo
```

Then edit `src/user.repository.ts` and type inside `UserRepository` methods such
as `findByName...` to inspect completions and diagnostics.
