# Node Persistence API (NPA)

NPA provides Spring Data JPA style repositories for Node and TypeScript. Application code
depends on `NPARepository<TEntity, TId>`, while the selected adapter handles the
actual database runtime such as PostgreSQL or MySQL.

## Install

Install the connector for the database you use. Each connector depends on the
core package and its own driver, so PostgreSQL users do not install `mysql2` and
MySQL users do not install `pg`.

PostgreSQL:

```bash
npm install @honeybeaers/npa-pg
```

MySQL:

```bash
npm install @honeybeaers/npa-mysql
```

## Entity Model

```ts
import {
  Column,
  Entity,
  Id,
  Index,
  ManyToMany,
  ManyToOne,
  NPARepository,
  OneToMany,
  Unique,
  Version,
} from '@honeybeaers/npa';

@Index({ name: 'idx_users_name_created_at', columns: ['name', 'createdAt'] })
@Entity({ name: 'users', schema: 'app' })
class User {
  @Id({ name: 'user_id' })
  id?: number;

  @Unique({ name: 'uidx_users_full_name' })
  @Column({ name: 'full_name' })
  name!: string;

  @Column({ name: 'created_at', index: 'idx_users_created_at' })
  createdAt!: Date;

  @Version()
  version!: number;

  @ManyToOne(() => Team, { joinColumn: 'team_id' })
  team?: Team;

  @ManyToMany(() => Role, { joinTable: 'user_roles' })
  roles?: Role[];
}
```

`@Entity`, `@Id`, and `@Column` drive table, primary key, and column mapping.
Use `@Version` for an optimistic lock column. Inserts default it to `0`; managed
entity dirty flushes check the previous value and increment it. Use `@Index` for
normal indexes and `@Unique` for unique indexes. Property-level
index decorators target that column; class-level decorators use property names in
`columns` for composite indexes. `@Column({ index: true })` and
`@Column({ unique: true })` are shorthand for single-column indexes. Relation
decorators are recorded as metadata for association support. Entity classes must
be exported so the generated client can import them.

## Repository Usage

Application code extends only NPA, not a database-specific repository type.
`NPARepository` provides JPA-style base methods including `findById`, `findAll`,
`existsById`, `count`, `save`, `insert`, `update`, `updateById`, `delete`,
`deleteById`, and `deleteAll`.

```ts
interface UserRepository extends NPARepository<User, number> {
  findTop10ByNameContainingOrderByCreatedAtDesc(
    name: string,
  ): Promise<User[]>;
  existsByName(name: string): Promise<boolean>;
  deleteByNameContaining(name: string): Promise<number>;
}
```

## CLI Generate

Run `npa generate` to create a typed client file. This is what makes method-name
query autocomplete visible in TypeScript. The generated client imports shared
repository types from `@honeybeaers/npa` and the selected
adapter factory from the connector package.

```bash
npa generate \
  --entities "src/**/*.entity.ts" \
  --out src/generated/npa.ts \
  --adapter postgresql
```

Use `--adapter mysql` to generate a MySQL-backed client factory.

Generated output includes:

```ts
import { NPARepository } from '@honeybeaers/npa';
import {
  PostgresqlQueryable,
  createPostgresqlDerivedQueryRepository,
} from '@honeybeaers/npa-pg';

export interface UserRepository extends NPARepository<User, number> {
  findByName(value: NonNullable<User['name']>): Promise<User[]>;
  findByNameContaining(value: NonNullable<User['name']>): Promise<User[]>;
  deleteByNameContaining(value: NonNullable<User['name']>): Promise<number>;
  countByCreatedAtBetween(
    min: NonNullable<User['createdAt']>,
    max: NonNullable<User['createdAt']>,
  ): Promise<number>;
}

export interface NPAClient {
  user: UserRepository;
}
```

The generator creates single-field method variants for `find`, `findOne`,
`exists`, `count`, and `delete`. Complex multi-field methods can still be
declared manually on your repository interface. Base methods such as
`findById`, `findAll`, and `deleteAll` come from `NPARepository`, so generated
interfaces do not need to repeat them.


## CLI Migrate

Run `npa migrate` to synchronize database tables from exported `@Entity`
classes. NPA creates missing tables, adds missing columns, changes supported
column types/nullability, drops columns removed from the entity, creates normal
and unique indexes, and creates `@ManyToMany({ joinTable })` tables. Rename
detection is not inferred; a rename is treated as a drop plus add, so review
dry-run SQL before applying it.

Create `npa.config.mjs`:

```js
export default {
  adapter: 'postgresql', // or 'mysql'
  url: process.env.DATABASE_URL,
  entities: ['src/**/*.entity.ts'],
  migrations: { table: '_npa_migrations' },
};
```

Preview SQL without touching the database:

```bash
npa migrate --dry-run
```

Apply it:

```bash
npa migrate
```

You can also pass flags directly:

```bash
npa migrate \
  --adapter mysql \
  --url "$DATABASE_URL" \
  --entities "src/**/*.entity.ts"
```

Default TypeScript-to-DB mapping is intentionally small: `string`, `number`,
`boolean`, and `Date`, with numeric `@Id` mapped to auto-increment primary keys.
Use `@Column({ type: 'VARCHAR(80)' })` when you need an explicit database type.
For many-to-many relations, NPA creates a join table with both primary-key
columns and a composite primary key, for example `@ManyToMany(() => Role,
{ joinTable: 'user_roles' })`. Dynamic decorator expressions are rejected by
migration parsing.

## Adapter Wiring

Choose the adapter in composition code. PostgreSQL and MySQL both implement the
same `NPARepositoryAdapter` contract.

### PostgreSQL

```ts
import { Pool } from 'pg';
import { PostgresqlConnection } from '@honeybeaers/npa-pg';
import { createNPAClient } from './generated/npa';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = new PostgresqlConnection(pool);

const npa = createNPAClient({
  postgresql: {
    queryable: connection,
  },
});

const users = npa.user;

await users.insert({ name: 'kim', createdAt: new Date() });
await users.save({ id: 1, name: 'lee', createdAt: new Date() });
await users.findById(1);
await users.findAll();
await users.existsById(1);
await users.count();
await users.updateById(1, { name: 'park' });
await users.deleteById(1);
await users.deleteAll();
await users.findTop10ByNameContainingOrderByCreatedAtDesc('ki');
```

### MySQL

Generate a MySQL client first:

```bash
npa generate \
  --entities "src/**/*.entity.ts" \
  --out src/generated/npa.ts \
  --adapter mysql
```

Then wire it with a `mysql2` pool or connection.

```ts
import mysql from 'mysql2/promise';
import { MysqlConnection } from '@honeybeaers/npa-mysql';
import { createNPAClient } from './generated/npa';

const pool = mysql.createPool(process.env.DATABASE_URL);
const connection = new MysqlConnection(pool);

const npa = createNPAClient({
  mysql: {
    queryable: connection,
  },
});

const users = npa.user;

await users.insert({ name: 'kim', createdAt: new Date() });
await users.save({ id: 1, name: 'lee', createdAt: new Date() });
await users.findById(1);
await users.findAll();
await users.existsById(1);
await users.count();
await users.updateById(1, { name: 'park' });
await users.deleteById(1);
await users.deleteAll();
await users.findTop10ByNameContainingOrderByCreatedAtDesc('ki');
```


## Transactions

Use a database transaction manager when multiple repository calls must commit or
roll back as one unit. Pass the manager's context-aware `queryable` to the
generated client, then decorate service methods with `@Transaction()`. The
default propagation is `required`, so nested transactional calls reuse the active
transaction. Use `{ propagation: 'requires_new' }` to force a separate
transaction.

```ts
import { Transaction } from '@honeybeaers/npa';
import { PostgresqlTransactionManager } from '@honeybeaers/npa-pg';
import { Pool } from 'pg';
import { createNPAClient } from './generated/npa';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const txManager = new PostgresqlTransactionManager(pool);
const npa = createNPAClient({
  postgresql: { queryable: txManager.queryable },
});

class UserService {
  constructor(
    private readonly users = npa.user,
    private readonly transactionManager = txManager,
  ) {}

  @Transaction()
  async renameUser(id: number, name: string): Promise<void> {
    await this.users.updateById(id, { name });
    await this.users.findById(id);
  }
}

const service = new UserService();
```

MySQL uses the same core decorator with `MysqlTransactionManager` from
`@honeybeaers/npa-mysql`. Transaction options currently support `isolation`,
`readOnly`, `required`, and `requires_new`.

## Dirty Checking and Versioning

Repository results loaded inside a transaction are managed by the active
`PersistenceContext`. Mutating a managed entity and returning from the
transaction flushes changed columns before commit. If the entity has `@Version`,
NPA updates with `WHERE id = ? AND version = ?`, increments the version column,
and throws `OptimisticLockError` when no row matches the expected version.

## Runtime Flow

1. Service code calls a method on `UserRepository`.
2. JPA-style base methods (`findById`, `findAll`, `existsById`, `count`,
   `save`, `insert`, `updateById`, `deleteById`, `deleteAll`) go through the NPA
   adapter directly.
3. Derived methods (`findBy...`, `existsBy...`, `countBy...`, `deleteBy...`) are
   parsed into a query AST.
4. The selected adapter compiles the AST with entity metadata and executes it.

## Develop

```bash
pnpm install
pnpm build
pnpm test
pnpm pack
```

### E2E Database Tests

Real database E2E tests run separately from the unit suite and use
Testcontainers to start PostgreSQL and MySQL automatically. The same repository
E2E flow runs directly against each database adapter and through a CLI-generated
client. The structure follows Prisma's scenario-oriented E2E style: a generated
client is compiled inside a temporary project, then the public repository API is
exercised against real providers.

```bash
pnpm test:e2e
```

Docker must be available in CI. On local machines without a container runtime,
the E2E tests are skipped with a diagnostic message. The tests create a unique
temporary table per database and stop the containers during cleanup. Override
container images with `NPA_E2E_POSTGRESQL_IMAGE` and `NPA_E2E_MYSQL_IMAGE` when
needed.

```bash
NPA_E2E_POSTGRESQL_IMAGE="postgres:16-alpine" \
NPA_E2E_MYSQL_IMAGE="mysql:8.0" \
pnpm test:e2e
```
