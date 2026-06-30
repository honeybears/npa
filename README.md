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
  OneToMany,
  ReferentialAction,
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

  @ManyToOne(() => Team, {
    joinColumn: 'team_id',
    foreignKeyName: 'fk_users_team',
    onDelete: ReferentialAction.SET_NULL,
  })
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
`@Column({ unique: true })` are shorthand for single-column indexes.
`@ManyToOne` creates a nullable foreign-key column using `joinColumn` or the
default `<property>_<targetIdColumn>` name. Use `foreignKeyName`, `onDelete`,
and `onUpdate` to control generated constraints. `@OneToMany` requires
`mappedBy`; `@ManyToMany` creates a join table. Entity classes must be exported
so the generated client can import them.

## Repository Usage

Application code extends only NPA, not a database-specific repository type.
`NPARepository` provides JPA-style base methods including `findById`, `findAll`,
`existsById`, `count`, `save`, `insert`, `update`, `updateById`, `delete`,
`deleteById`, and `deleteAll`.

Declare repositories as abstract classes and bind them to entities with
`@Repository`. NPA creates the concrete implementation at runtime with a
`Proxy`, so only the methods you want autocomplete for need to be declared.

```ts
import { NPARepository, Repository } from '@honeybeaers/npa';

@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  abstract findTop10ByNameContainingOrderByCreatedAtDesc(
    name: string,
  ): Promise<User[]>;
  abstract existsByName(name: string): Promise<boolean>;
  abstract deleteByNameContaining(name: string): Promise<number>;
}
```

Load relations explicitly on base reads:

```ts
const user = await users.findById(1, { relations: ['team', 'roles'] });
const teams = await teamRepository.findAll({ relations: ['members'] });
```

## CLI Generate

Run `npa generate repositories` when you want Spring Data JPA-style method-name
autocomplete without writing every derived-query declaration by hand. The CLI
scans exported `@Entity` classes and writes abstract repository token classes.

```bash
npa generate repositories \
  --entities "src/**/*.entity.ts" \
  --out src/generated/repositories.ts
```

Generated output includes:

```ts
import { NPARepository, Repository } from '@honeybeaers/npa';

@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  abstract findByName(value: NonNullable<User['name']>): Promise<User[]>;
  abstract findByNameContaining(value: NonNullable<User['name']>): Promise<User[]>;
  abstract deleteByNameContaining(value: NonNullable<User['name']>): Promise<number>;
}

export const npaRepositories = [UserRepository] as const;
```

Register the generated tokens once and ask NPA for the concrete Proxy-backed
implementation at runtime:

```ts
import { createNPA } from '@honeybeaers/npa';
import { postgresql } from '@honeybeaers/npa-pg';
import { UserRepository, npaRepositories } from './generated/repositories';

const npa = createNPA({
  adapter: postgresql({ queryable: connection }),
  repositories: npaRepositories,
});

const users = npa.get(UserRepository);
await users.findByNameContaining('kim');
```

The generator creates single-field method variants for `find`, `findOne`,
`exists`, `count`, and `delete`. Complex multi-field methods can still be
declared manually on your repository class. Base methods such as `findById`,
`findAll`, and `deleteAll` come from `NPARepository`, so generated declarations
do not need to repeat them.

The legacy typed-client generator is still available as `npa generate client`
or the backward-compatible `npa generate` alias. Use `--adapter mysql` to emit a
MySQL-backed client factory.

```bash
npa generate client \
  --entities "src/**/*.entity.ts" \
  --out src/generated/npa.ts \
  --adapter postgresql
```

Client output includes:

```ts
import { NPARepository } from '@honeybeaers/npa';
import { createPostgresqlDerivedQueryRepository } from '@honeybeaers/npa-pg';

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


## Schema Push and Migrations

Use `npa db push` for Prisma `db push`-style local synchronization: NPA reads
exported `@Entity` classes and applies the current schema directly to the
database. It creates missing tables, adds missing columns, changes supported
column types/nullability, drops columns removed from the entity, creates normal
and unique indexes, creates `@ManyToOne` foreign keys, and creates
`@ManyToMany({ joinTable })` tables with foreign keys. Rename detection is not
inferred; a rename is treated as a drop plus add, so review dry-run SQL before
applying it.

Create `npa.config.mjs`:

```js
export default {
  adapter: 'postgresql', // or 'mysql'
  url: process.env.DATABASE_URL,
  entities: ['src/**/*.entity.ts'],
  migrations: {
    dir: 'npa/migrations',
    table: '_npa_migrations',
  },
};
```

Preview SQL without touching the database:

```bash
npa db push --dry-run
```

Push the current entity schema directly:

```bash
npa db push
```

Use migration files for a Prisma `migrate dev` / `migrate deploy`-style flow:

```bash
npa migrate dev --name init
npa migrate deploy
```

`migrate dev` applies pending local migration files, creates a new
`npa/migrations/<timestamp>_<name>/migration.sql` from the current entity diff,
and applies it unless `--create-only` is passed. `migrate deploy` does not parse
entities; it applies pending migration files in order and verifies their
checksums against `_npa_migrations`. You can also pass flags directly:

```bash
npa migrate dev \
  --name add_users \
  --adapter mysql \
  --url "$DATABASE_URL" \
  --entities "src/**/*.entity.ts"
```

Default TypeScript-to-DB mapping is intentionally small: `string`, `number`,
`boolean`, and `Date`, with numeric `@Id` mapped to auto-increment primary keys.
Use `@Column({ type: 'VARCHAR(80)' })` when you need an explicit database type.
For many-to-many relations, NPA creates a join table with both primary-key
columns, a composite primary key, and foreign keys back to each side, for
example `@ManyToMany(() => Role, { joinTable: 'user_roles' })`. Dynamic
decorator expressions are rejected by migration parsing.

## Adapter Wiring

Choose the adapter in composition code. PostgreSQL and MySQL both implement the
same runtime adapter contract used by `createNPA`.

### PostgreSQL

```ts
import { Pool } from 'pg';
import { createNPA } from '@honeybeaers/npa';
import { PostgresqlConnection, postgresql } from '@honeybeaers/npa-pg';
import { UserRepository } from './user.repository';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = new PostgresqlConnection(pool);

const npa = createNPA({
  adapter: postgresql({ queryable: connection }),
  repositories: [UserRepository],
});

const users = npa.get(UserRepository);

await users.insert({ name: 'kim', createdAt: new Date() });
await users.save({ id: 1, name: 'lee', createdAt: new Date() });
await users.findById(1, { relations: ['team', 'roles'] });
await users.findAll({ relations: ['team'] });
await users.existsById(1);
await users.count();
await users.updateById(1, { name: 'park' });
await users.deleteById(1);
await users.deleteAll();
await users.findTop10ByNameContainingOrderByCreatedAtDesc('ki');
```

### MySQL

Wire the MySQL adapter with a `mysql2` pool or connection.

```ts
import mysql from 'mysql2/promise';
import { createNPA } from '@honeybeaers/npa';
import { MysqlConnection, mysql as npaMysql } from '@honeybeaers/npa-mysql';
import { UserRepository } from './user.repository';

const pool = mysql.createPool(process.env.DATABASE_URL);
const connection = new MysqlConnection(pool);

const npa = createNPA({
  adapter: npaMysql({ queryable: connection }),
  repositories: [UserRepository],
});

const users = npa.get(UserRepository);

await users.insert({ name: 'kim', createdAt: new Date() });
await users.save({ id: 1, name: 'lee', createdAt: new Date() });
await users.findById(1, { relations: ['team', 'roles'] });
await users.findAll({ relations: ['team'] });
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
runtime adapter, then decorate service methods with `@Transaction()`. The
default propagation is `NPATransactionPropagation.REQUIRED`, so nested
transactional calls reuse the active transaction. Use
`{ propagation: NPATransactionPropagation.REQUIRES_NEW }` to force a separate
transaction.

```ts
import {
  NPATransactionIsolation,
  NPATransactionPropagation,
  Transaction,
  createNPA,
} from '@honeybeaers/npa';
import { PostgresqlTransactionManager, postgresql } from '@honeybeaers/npa-pg';
import { Pool } from 'pg';
import { UserRepository } from './user.repository';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const txManager = new PostgresqlTransactionManager(pool);
const npa = createNPA({
  adapter: postgresql({ queryable: txManager.queryable }),
  repositories: [UserRepository],
});

class UserService {
  constructor(
    private readonly users = npa.get(UserRepository),
    private readonly transactionManager = txManager,
  ) {}

  @Transaction({ isolation: NPATransactionIsolation.READ_COMMITTED })
  async renameUser(id: number, name: string): Promise<void> {
    await this.users.updateById(id, { name });
    await this.users.findById(id);
  }
}

const service = new UserService();
```

MySQL uses the same core decorator with `MysqlTransactionManager` from
`@honeybeaers/npa-mysql`. Transaction options currently support `isolation`,
`readOnly`, `NPATransactionPropagation.REQUIRED`, and
`NPATransactionPropagation.REQUIRES_NEW`.

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
