# NPA Node MySQL Example

This example wires `@node-persistence-api/core` to `@node-persistence-api/connector-mysql` with local
workspace dependencies.

The app imports `src/repositories.ts` before constructing `NPA`, so decorated
repositories are registered without passing `repositories` manually.

```bash
pnpm --filter npa-example-node-mysql demo
```

Without `DATABASE_URL`, the demo uses a logging queryable and prints generated
SQL. With `DATABASE_URL`, it uses `mysql2/promise` through `MysqlConnection`.

```bash
export DATABASE_URL=mysql://root:root@localhost:3306/npa_demo
pnpm --filter npa-example-node-mysql db:push
pnpm --filter npa-example-node-mysql demo
```
