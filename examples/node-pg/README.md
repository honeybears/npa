# NPA Node PostgreSQL Example

This example wires `@honeybeaers/npa` to `@honeybeaers/npa-pg` with local
workspace dependencies.

```bash
pnpm --filter npa-example-node-pg demo
```

Without `DATABASE_URL`, the demo uses a logging queryable and prints generated
SQL. With `DATABASE_URL`, it uses `pg.Pool` through `PostgresqlConnection`.

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/npa_demo
pnpm --filter npa-example-node-pg db:push
pnpm --filter npa-example-node-pg demo
```
