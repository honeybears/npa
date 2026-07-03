# Node Persistence API (NPA)

[GitHub: honeybears/Node-Persistence-API](https://github.com/honeybears/Node-Persistence-API)

NPA provides repository APIs for Node and TypeScript inspired by familiar
persistence patterns from the Java ecosystem. Application code depends on
`NPARepository<TEntity, TId>`, while the selected adapter handles the actual
database runtime such as PostgreSQL or MySQL.

NPA is an independent project. It is not affiliated with Oracle, the Eclipse
Foundation, Jakarta EE, Spring, or Broadcom.

## Packages

| Package | README | Purpose |
| --- | --- | --- |
| `@node-persistence-api/core` | this file | decorators, repositories, migrations, transactions |
| `@node-persistence-api/connector-pg` | [packages/pg](./packages/pg/README.md) | PostgreSQL runtime adapter |
| `@node-persistence-api/connector-mysql` | [packages/mysql](./packages/mysql/README.md) | MySQL runtime adapter |
| `@node-persistence-api/language` | [packages/language](./packages/language/README.md) | editor-independent completions and diagnostics |
| `npa` | [packages/vscode](./packages/vscode/README.md) | VS Code extension |

## Install

Install the connector for the database you use. Each connector depends on the
core package and its own driver, so PostgreSQL users do not install `mysql2` and
MySQL users do not install `pg`.

PostgreSQL:

```bash
npm install @node-persistence-api/connector-pg
```

MySQL:

```bash
npm install @node-persistence-api/connector-mysql
```

## Examples

The repository includes local workspace demos for PostgreSQL, MySQL, and editor
language helpers.

```bash
pnpm --filter npa-example-node-pg demo
pnpm --filter npa-example-node-mysql demo
pnpm --filter npa-example-vscode-demo demo
```

The database demos run without `DATABASE_URL` by printing generated SQL through
a mock queryable. Set `DATABASE_URL` and run `db:push` in the example package to
exercise a real database.

## Entity Model

```ts
import {
  Column,
  CreatedAt,
  CascadeType,
  Entity,
  GenerationStrategy,
  Id,
  Index,
  ManyToMany,
  ManyToOne,
  OneToOne,
  OneToMany,
  ReferentialAction,
  UpdatedAt,
  Version,
  type Relation,
} from '@node-persistence-api/core';

@Index([
  { name: 'idx_users_name_created_at', columns: ['name', 'createdAt'] },
  { name: 'uidx_users_name_created_at', columns: ['name', 'createdAt'], unique: true },
])
@Entity({ name: 'users', schema: 'app' })
class User {
  @Id({ name: 'user_id', generationStrategy: GenerationStrategy.AUTO_INCREMENT })
  id?: number;

  @Column({ name: 'full_name', unique: 'uidx_users_full_name' })
  name!: string;

  @CreatedAt({ name: 'created_at', index: 'idx_users_created_at' })
  createdAt!: Date;

  @UpdatedAt({ name: 'updated_at' })
  updatedAt!: Date;

  @Version()
  version!: number;

  @ManyToOne(() => Team, {
    joinColumn: 'team_id',
    foreignKeyName: 'fk_users_team',
    onDelete: ReferentialAction.SET_NULL,
    cascade: [CascadeType.PERSIST],
  })
  team?: Relation<Team | null>;

  @ManyToMany(() => Role, { joinTable: 'user_roles' })
  roles?: Relation<Role[]>;
}
```

`@Entity`, `@Id`, and `@Column` drive table, primary key, and column mapping.
`@Id()` by itself creates a primary-key column without generated values. Pass
`generationStrategy: GenerationStrategy.AUTO_INCREMENT`,
`GenerationStrategy.SEQUENCE`, or `GenerationStrategy.UUID` when the database
should generate ids. PostgreSQL supports all three strategies. MySQL supports
`AUTO_INCREMENT` and `UUID`; `SEQUENCE` is rejected because MySQL does not
provide normal sequence objects.
Use `@CreatedAt` and `@UpdatedAt` for timestamp columns; migrations default them
to the current timestamp, and updates refresh `@UpdatedAt`. Use `@Version` for
an optimistic lock column. Inserts default it to `0`; managed
entity dirty flushes check the previous value and increment it. Use class-level
`@Index` with property names in `columns` for composite indexes. Pass an array
to `@Index` to declare multiple indexes, and set `unique: true` for composite
unique indexes. `@Column({ index: true })` and
`@Column({ unique: true })` are shorthand for single-column indexes.
Multiple `@Id` columns define a composite primary key for direct CRUD calls;
pass an object id such as `{ tenantId, userId }` to `findById`, `updateById`,
`existsById`, or `deleteById`. Composite ids are not yet supported for relation
foreign keys or join tables.
`@ManyToOne` and owning `@OneToOne` create a nullable foreign-key column using
`joinColumn` or the default `<property>_<targetIdColumn>` name. Owning
`@OneToOne` also creates a unique index for that foreign key in migrations. Use
`foreignKeyName`, `onDelete`, and `onUpdate` to control generated constraints.
Inverse `@OneToOne` and `@OneToMany` require `mappedBy`; `@ManyToMany` creates a
join table. Use `cascade` with
`[CascadeType.PERSIST]` or `CascadeType.REMOVE` for loaded or lazy relation
values that should be persisted or removed with the owning operation. For
`@ManyToMany`, `PERSIST` can persist id-less targets and `REMOVE` deletes target
entities when configured; remove operations also clean join rows. Loaded owner
or inverse `@ManyToMany` arrays flush join-table rows. Loaded `@OneToMany`
arrays update the owning `@ManyToOne` foreign key; set `orphanRemoval: true` to
delete children removed from the collection. `Relation<T>` lets a relation field
hold either a lazy promise or an explicitly loaded value. Entity classes must be
exported so repositories, application code, and migration tooling can reference
them.

## Repository Usage

Application code extends only NPA, not a database-specific repository type.
`NPARepository` provides familiar persistence base methods including `findById`,
`findAll`, `existsById`, `count`, `persist`, `save`, `insert`, `update`,
`updateById`, `remove`, `delete`, `deleteById`, and `deleteAll`.

Declare repositories as abstract classes and bind them to entities with
`@Repository`. Imported decorated repositories are auto-registered when
`new NPA({ adapter })` runs. Pass `repositories: [UserRepository]` only when
you want to restrict an NPA instance to an explicit subset. NPA creates the
concrete implementation at runtime with a `Proxy`, so only the methods you want
autocomplete for need to be declared.

Repository decorators run when their module is imported. In applications, keep a
bootstrap barrel that imports or re-exports every repository module before
constructing `NPA`:

```ts
// src/repositories.ts
export { UserRepository } from './user.repository';
export { TeamRepository } from './team.repository';

// src/main.ts
import './repositories';
import { UserRepository } from './user.repository';

const npa = new NPA({ adapter });
const users = npa.get(UserRepository);
```

```ts
import {
  EntityGraph,
  NPARepository,
  Repository,
  defineEntityGraph,
  type Loaded,
} from '@node-persistence-api/core';

const userGraph = defineEntityGraph<User>({
  roles: true,
  team: {
    organization: true,
  },
});

@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  @EntityGraph(userGraph)
  abstract findByName: (
    name: string,
  ) => Promise<Loaded<User, typeof userGraph>[]>;

  abstract findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc(
    name: string,
  ): Promise<User[]>;
  abstract findFirstByEmailAllIgnoreCase(email: string): Promise<User[]>;
  abstract existsByName(name: string): Promise<boolean>;
  abstract deleteByNameContaining(name: string): Promise<number>;
}
```

Supported query modifiers include `Distinct`, `IgnoreCase`, `AllIgnoreCase`,
`First`/`Top`, and compound order clauses such as `OrderByNameAscAgeDesc`.

Load relations explicitly on base reads:

```ts
const user = await users.findById(1, {
  relations: {
    roles: true,
    team: {
      organization: true,
    },
  },
});
const teams = await teamRepository.findAll({ relations: { members: true } });
```

Sort or project base reads without creating derived methods:

```ts
const activeUsers = await users.findAll({
  orderBy: [
    { property: 'createdAt', direction: 'desc' },
    { property: 'id' },
  ],
});

const names = await users.findAll({
  select: ['id', 'name'] as const,
  orderBy: [{ property: 'name' }],
});
```

`select` projection returns plain partial rows keyed by entity property names.
`select` cannot be combined with relation loading or `@EntityGraph`. Cursor
pagination can use projection rows; NPA adds any ordered cursor values as hidden
select aliases and removes them before returning content. Cursor pagination can
also be combined with relation loading or `@EntityGraph` when returning full
entity rows.

Use `@EntityGraph` on a repository method when that method should always load
specific relations. Undecorated query methods do not receive entity graph
metadata. NPA follows a MikroORM-style loaded type pattern: declare graph-loaded
methods with `Loaded<TEntity, Graph>` so selected relation fields are typed as
their resolved values instead of promises.

```ts
// Reuse the userGraph constant from the repository example above.
@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  @EntityGraph(userGraph)
  abstract findByEmailAllIgnoreCase: (
    email: string,
  ) => Promise<Loaded<User, typeof userGraph>[]>;
}
```

TypeScript does not allow decorators on abstract method declarations. For
decorated derived query methods, declare an abstract function property as shown
above.

Relation fields are lazy-loadable when they were not loaded explicitly:

```ts
const user = await users.findById(1);
const team = await user.team;
const roles = await user.roles;
```

Derived query methods can also filter on relation fields. NPA joins relation
targets when a method uses `relationProperty + TargetColumn`, while direct
columns still take precedence if a matching column exists. Nested relation paths
can chain the same rule.

```ts
@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  abstract findByTeamNameAndName(teamName: string, name: string): Promise<User[]>;
  abstract findByTeamOrganizationName(name: string): Promise<User[]>;
  abstract existsByRolesName(roleName: string): Promise<boolean>;
}
```

Supported relation predicates include `@ManyToOne`, `@OneToOne`,
`@OneToMany({ mappedBy })`, and `@ManyToMany({ joinTable })` target columns.

## Custom SQL with `@Query`

Use `@Query` for repository methods that should bypass method-name parsing and
execute SQL directly. TypeScript decorators cannot be applied to abstract method
signatures, and `declare` class fields cannot be decorated. Declare raw-query
methods as decorated function properties with a definite assignment assertion.
The VS Code extension flags `@Query` methods that are not function properties.
Named placeholders such as `:email` are bound from repository method arguments
in first-appearance order. Reusing the same placeholder name reuses the
same argument. MySQL receives `?` placeholders; PostgreSQL receives `$1`, `$2`, ... .

```ts
import { NPARepository, Query, Repository } from '@node-persistence-api/core';

@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  @Query('SELECT * FROM users WHERE email = :email', { result: 'one', managed: true })
  findByEmailSql!: (email: string) => Promise<User | null>;

  @Query('SELECT COUNT(*) AS total FROM users WHERE active = :active', { result: 'scalar' })
  countActiveSql!: (active: boolean) => Promise<number>;

  @Query('UPDATE users SET active = :active WHERE id = :id', { result: 'execute' })
  updateActiveSql!: (active: boolean, id: number) => Promise<number>;
}
```

Result modes are `many` (default rows array), `one` (first row or `null`),
`scalar` (first column of the first row), and `execute` (affected row count).
Use `?` or `$1` placeholders only when you specifically want positional SQL.
Raw query rows are not dirty-checked unless `managed: true` is set.

## Schema Push and Migrations

Use `npa db push` for Prisma `db push`-style local synchronization: NPA reads
exported `@Entity` classes and applies the current schema directly to the
database. It creates missing tables, adds missing columns, changes supported
column types/nullability, drops columns removed from the entity, creates normal
and unique indexes, creates `@ManyToOne` and owning `@OneToOne` foreign keys,
and creates `@ManyToMany({ joinTable })` tables with foreign keys. Destructive statements
such as dropped columns and risky type/nullability changes require
`--allow-destructive` before they can be applied. Rename detection is explicit:
pass `--rename table:old_name=new_name` or
`--rename column:users.old_name=new_name` when a change should be generated as
a rename instead of drop plus add.

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
writes a best-effort `down.sql`, and applies it unless `--create-only` is
passed. `migrate deploy` does not parse entities; it applies pending migration
files in order, verifies their checksums against `_npa_migrations`, and fails
when the database contains applied migration history that is missing locally
unless `--allow-drift` is passed. You can also pass flags directly:

```bash
npa migrate dev \
  --name add_users \
  --adapter mysql \
  --url "$DATABASE_URL" \
  --entities "src/**/*.entity.ts" \
  --rename "column:users.full_name=name"
```

Default TypeScript-to-DB mapping is intentionally small: `string`, `number`,
`boolean`, and `Date`. Numeric `@Id` is a normal integer primary key unless
`generationStrategy: GenerationStrategy.AUTO_INCREMENT` is specified.
Use `@Column({ type: 'VARCHAR(80)' })` when you need an explicit database type.
For many-to-many relations, NPA creates a join table with both primary-key
columns, a composite primary key, and foreign keys back to each side, for
example `@ManyToMany(() => Role, { joinTable: 'user_roles' })`. Dynamic
decorator expressions are rejected by migration parsing.

## Adapter Wiring

Choose the adapter in composition code. PostgreSQL and MySQL both implement the
same runtime adapter contract used by `new NPA()`.

### PostgreSQL

```ts
import { Pool } from 'pg';
import { NPA } from '@node-persistence-api/core';
import { PostgresqlConnection, postgresql } from '@node-persistence-api/connector-pg';
import './repositories';
import { UserRepository } from './user.repository';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = new PostgresqlConnection(pool);

const npa = new NPA({
  adapter: postgresql({ queryable: connection }),
});

const users = npa.get(UserRepository);

await users.insert({ name: 'kim', createdAt: new Date() });
await users.save({ id: 1, name: 'lee', createdAt: new Date() });
await users.findById(1, { relations: { roles: true, team: true } });
await users.findAll({ relations: { team: true } });
await users.existsById(1);
await users.count();
await users.updateById(1, { name: 'park' });
await users.deleteById(1);
await users.deleteAll();
await users.findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc('ki');
```

### MySQL

Wire the MySQL adapter with a `mysql2` pool or connection.

```ts
import mysql from 'mysql2/promise';
import { NPA } from '@node-persistence-api/core';
import { MysqlConnection, mysql as npaMysql } from '@node-persistence-api/connector-mysql';
import './repositories';
import { UserRepository } from './user.repository';

const pool = mysql.createPool(process.env.DATABASE_URL);
const connection = new MysqlConnection(pool);

const npa = new NPA({
  adapter: npaMysql({ queryable: connection }),
});

const users = npa.get(UserRepository);

await users.insert({ name: 'kim', createdAt: new Date() });
await users.save({ id: 1, name: 'lee', createdAt: new Date() });
await users.findById(1, { relations: { roles: true, team: true } });
await users.findAll({ relations: { team: true } });
await users.existsById(1);
await users.count();
await users.updateById(1, { name: 'park' });
await users.deleteById(1);
await users.deleteAll();
await users.findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc('ki');
```


## Transactions

Use a database transaction manager when multiple repository calls must commit or
roll back as one unit. Pass the manager's context-aware `queryable` to the
runtime adapter, then decorate service methods with `@Transaction()`. The
default propagation is `TransactionPropagation.REQUIRED`, so nested
transactional calls reuse the active transaction. Use
`{ propagation: TransactionPropagation.REQUIRES_NEW }` to force a separate
transaction.

```ts
import {
  TransactionIsolation,
  TransactionPropagation,
  Transaction,
  NPA,
} from '@node-persistence-api/core';
import { PostgresqlTransactionManager, postgresql } from '@node-persistence-api/connector-pg';
import { Pool } from 'pg';
import './repositories';
import { UserRepository } from './user.repository';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const txManager = new PostgresqlTransactionManager(pool);
const npa = new NPA({
  adapter: postgresql({ queryable: txManager.queryable }),
});

class UserService {
  constructor(
    private readonly users = npa.get(UserRepository),
    private readonly transactionManager = txManager,
  ) {}

  @Transaction({ isolation: TransactionIsolation.READ_COMMITTED })
  async renameUser(id: number, name: string): Promise<void> {
    await this.users.updateById(id, { name });
    await this.users.findById(id);
  }
}

const service = new UserService();
```

MySQL uses the same core decorator with `MysqlTransactionManager` from
`@node-persistence-api/connector-mysql`. Transaction options currently support `isolation`,
`readOnly`, `TransactionPropagation.REQUIRED`, and
`TransactionPropagation.REQUIRES_NEW`.

## Dirty Checking and Versioning

Repository results loaded inside a transaction are managed by the active
`PersistenceContext`. Mutating a managed entity and returning from the
transaction flushes changed columns before commit. If the entity has `@Version`,
NPA updates with `WHERE id = ? AND version = ?`, increments the version column,
and throws `OptimisticLockError` when no row matches the expected version.
`repository.persist(entity)` and `repository.remove(entity)` also use the active
context, so inserts and deletes flush with the transaction.

## Pagination

`findAll` accepts `pageable` together with relation load options. Offset
pagination returns `Page<T>` with a count query; cursor pagination returns
`CursorPage<T>` with bidirectional keyset cursors.

```ts
import { Pageable, type CursorPage, type Page } from '@node-persistence-api/core';

const page: Page<User> = await users.findAll({
  relations: { profile: true },
  pageable: Pageable.offset(0, 20),
});

const first: CursorPage<User> =
  await users.findByStatusOrderByCreatedAtDesc(
    'active',
    Pageable.cursor({ size: 20 }),
  );

const next = await users.findByStatusOrderByCreatedAtDesc(
  'active',
  Pageable.cursor({ after: first.nextCursor!, size: 20 }),
);
```

Cursor ordering uses the derived `OrderBy` clause, or the primary key ascending
when no order is declared. NPA appends the primary key as a tie-breaker. `before`
performs the same keyset query in the opposite direction and reverses the
returned rows.

```ts
abstract class MemberRepository extends NPARepository<Member, number> {
  abstract findByNameOrderByTeamLabelAsc(
    name: string,
    pageable: ReturnType<typeof Pageable.cursor>,
  ): Promise<CursorPage<Member>>;
}
```

Cursor order currently supports scalar columns and to-one relation chains such
as `OrderByTeamLabelAsc`. `OneToMany` and `ManyToMany` cursor order fail
fast because the aggregation policy is not part of the v1 contract. `after` and
`before` cannot be used together, and `Top`/`First` cannot be combined with
`Pageable`.

## Runtime Flow

1. Service code calls a method on `UserRepository`.
2. Familiar persistence base methods (`findById`, `findAll`, `existsById`, `count`,
   `persist`, `save`, `insert`, `updateById`, `remove`, `deleteById`,
   `deleteAll`) go through the NPA adapter directly or the active persistence
   context. Deletes on entities with cascade remove or join-table cleanup load
   matching rows and run the remove path.
3. Derived methods (`findBy...`, `existsBy...`, `countBy...`, `deleteBy...`) are
   parsed into a query AST.
4. The selected adapter compiles the AST with entity metadata and executes it.

## Language Helpers

`@node-persistence-api/language` is an editor-independent package for future VS Code
and IDEA support. It does not execute user code or talk to a database. Feed it an
entity schema and it returns repository method completions and diagnostics
inspired by Spring Data patterns.

```ts
import {
  getNPAQueryMethodCompletions,
  validateNPAQueryMethod,
} from '@node-persistence-api/language';

const completions = getNPAQueryMethodCompletions({
  prefix: 'findByNa',
  entity: userSchema,
  workspace,
  includeOrderBy: true,
  includePageable: true,
});

const result = validateNPAQueryMethod({
  methodName: 'findByTeamNameAndAgeGreaterThan',
  entity: userSchema,
  workspace,
});
```

VS Code or IDEA plugins should handle editor integration only: collect TypeScript
entity schemas, call this package, and render completions/diagnostics.

The `packages/vscode` workspace contains the first VS Code MVP. It registers a
completion provider and diagnostics for TypeScript repositories extending
`NPARepository<Entity, Id>`, then delegates method suggestions and validation to
`@node-persistence-api/language`.

## Develop

```bash
pnpm install
pnpm build
pnpm test
pnpm pack
```

For the first npm release checklist and package order, see
[`RELEASE.md`](./RELEASE.md).

### TODO

The current codebase is suitable for demos, but the following items are needed
before treating NPA as a fuller ORM:

- Query planning: cache parsed method names and compiled SQL templates per entity, adapter, and method name so repeat calls only bind values.
- Query API: add aggregate/groupBy support and bulk update by condition.
- Batching: add findUnique-style same-tick batching and relation-loading batching inside transaction-aware scopes.
- Relations: support eager fetch strategies and safer relation mutation helpers.
- Entity mapping: add composite relation keys, enum/json/array types, embedded value objects, column transformers, inheritance, and lifecycle hooks.
- Migrations: add data migration hooks and richer DDL for defaults/generated columns/enums.
- Transactions: add savepoint-backed nested transactions, more propagation modes, and stricter read-only/flush behavior.
- Operations: add SQL logging, slow-query hooks, metrics/tracing, normalized driver errors, retry policy hooks, and clearer connection ownership docs.
- Tooling: harden package publishing, keep examples current, and expand editor support beyond the VS Code MVP.

### E2E Database Tests

Real database E2E tests run separately from the unit suite and use
Testcontainers to start PostgreSQL and MySQL automatically. The suite exercises
repository operations, relation-field derived queries, transactions,
`db push`, and `migrate dev` / `migrate deploy` against real providers.

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
