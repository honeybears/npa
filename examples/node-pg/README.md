# NPA Node PostgreSQL Example

This example wires `@node-persistence-api/core` to `@node-persistence-api/connector-pg` with local
workspace dependencies.

The app imports `src/repositories.ts` before constructing `NPA`, so decorated
repositories are registered without passing `repositories` manually.

```bash
pnpm --filter npa-example-node-pg demo
```

Without `DATABASE_URL`, the demo starts a PostgreSQL Testcontainer and seeds
the `users` table. With `DATABASE_URL`, it uses `pg.Pool` through
`PostgresqlConnection`.

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/npa_demo
pnpm --filter npa-example-node-pg db:push
pnpm --filter npa-example-node-pg demo
```
