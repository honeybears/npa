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
`existsById`, or `deleteById`. Composite ids are also supported for owning
relation foreign keys and many-to-many join tables.
`@ManyToOne` and owning `@OneToOne` create nullable foreign-key columns by
default using `joinColumn` or the default `<property>_<targetIdColumn>` name;
set `nullable: false` to generate `NOT NULL`. Owning `@OneToOne` also creates a
unique index for that foreign key in migrations. Use `joinColumns` when a
relation targets a composite id and needs explicit foreign key column names. Use
`foreignKeyName`, `onDelete`, and `onUpdate` to control generated constraints.
Inverse `@OneToOne` and `@OneToMany` require `mappedBy`; `@ManyToMany` creates a
join table. Use `cascade` with
`[CascadeType.PERSIST]` or `CascadeType.REMOVE` for loaded or lazy relation
values that should be persisted or removed with the owning operation. For
`@ManyToMany`, `PERSIST` can persist id-less targets and `REMOVE` deletes target
entities when configured; remove operations also clean join rows. Loaded owner
or inverse `@ManyToMany` arrays flush join-table rows. Loaded `@OneToMany`
arrays update the owning `@ManyToOne` foreign key; set `orphanRemoval: true` to
delete children removed from the collection. Relations are lazy by default; set
`fetch: FetchType.EAGER` to load a relation automatically with repository reads.
`Relation<T>` lets a relation field hold either a lazy promise or an explicitly
loaded value. Entity classes must be exported so repositories, application code,
and migration tooling can reference them.

## Repository Usage

Application code extends only NPA, not a database-specific repository type.
`NPARepository` provides familiar persistence base methods including `findById`,
`findAll`, `existsById`, `count`, `persist`, `save`, `insert`, `update`,
`updateById`, `remove`, `delete`, `deleteById`, and `deleteAll`.

Declare repositories as abstract classes and bind them to entities with
`@Repository`. Imported decorated repositories are auto-registered when
`createNPA({ adapter })` runs. Pass `repositories: [UserRepository]` only when
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
import { createNPA } from '@node-persistence-api/core';
import './repositories';
import { UserRepository } from './user.repository';

const npa = createNPA({ adapter });
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
  abstract countByTeamName(name: string): Promise<number>;
  abstract countDistinctByRolesName(name: string): Promise<number>;
  abstract deleteByNameContaining(name: string): Promise<number>;
}
```

Supported query modifiers include `Distinct`, `IgnoreCase`, `AllIgnoreCase`,
`First`/`Top`, and compound order clauses such as `OrderByNameAscAgeDesc`.
Use `countBy...` for simple counts and `countDistinctBy...` when relation joins
can duplicate the root row. Aggregates beyond count, grouping, and custom
projections belong in `@Query`.

Sort or project base reads without creating derived methods:

```ts
const activeUsers = await users.findAll({
  orderBy: [
    { property: 'createdAt', direction: 'desc' },
    { property: 'id' },
  ],
});

const names = await users.findAll({ orderBy: [{ property: 'name' }] });
```

Cursor pagination can also be combined with `@EntityGraph`.

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

Derived query methods can also filter on relation fields. NPA compares direct
owning relation properties against their foreign-key columns, including
composite keys, and joins relation targets when a method uses
`relationProperty + TargetColumn`. Direct columns still take precedence if a
matching column exists. Nested relation paths can chain the same rule.

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
passed. Use `--migrations-dir <dir>` or `migrations.dir` in `npa.config.mjs` to
write and read migration files from a custom directory. `migrate deploy` does
not parse entities; it applies pending migration files in order, verifies their
checksums against `_npa_migrations`, and fails when a previously applied file's
checksum changed or when the database contains applied migration history that is
missing locally unless `--allow-drift` is passed. You can also pass flags
directly:

```bash
npa migrate dev \
  --name add_users \
  --adapter mysql \
  --url "$DATABASE_URL" \
  --migrations-dir db/migrations \
  --entities "src/**/*.entity.ts" \
  --rename "column:users.full_name=name"
```

Default TypeScript-to-DB mapping is intentionally small: `string`, `number`,
`boolean`, and `Date`. Numeric `@Id` is a normal integer primary key unless
`generationStrategy: GenerationStrategy.AUTO_INCREMENT` is specified.
Use `@Column({ type: 'VARCHAR(80)' })` when you need an explicit database type.
For many-to-many relations, NPA creates a join table with all primary-key
columns from both sides, a composite primary key, and foreign keys back to each
side, for example `@ManyToMany(() => Role, { joinTable: 'user_roles' })`. Dynamic
decorator expressions are rejected by migration parsing.

## Adapter Wiring

Choose the adapter in composition code. PostgreSQL and MySQL both implement the
same runtime adapter contract used by `createNPA()`.

### PostgreSQL

```ts
import { Pool } from 'pg';
import { createNPA } from '@node-persistence-api/core';
import { PostgresqlConnection, postgresql } from '@node-persistence-api/connector-pg';
import './repositories';
import { UserRepository } from './user.repository';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = new PostgresqlConnection(pool);

const npa = createNPA({
  adapter: postgresql({ queryable: connection }),
});

const users = npa.get(UserRepository);

await users.insert({ name: 'kim', createdAt: new Date() });
await users.save({ id: 1, name: 'lee', createdAt: new Date() });
await users.findById(1);
await users.findAll();
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
import { createNPA } from '@node-persistence-api/core';
import { MysqlConnection, mysql as npaMysql } from '@node-persistence-api/connector-mysql';
import './repositories';
import { UserRepository } from './user.repository';

const pool = mysql.createPool(process.env.DATABASE_URL);
const connection = new MysqlConnection(pool);

const npa = createNPA({
  adapter: npaMysql({ queryable: connection }),
});

const users = npa.get(UserRepository);

await users.insert({ name: 'kim', createdAt: new Date() });
await users.save({ id: 1, name: 'lee', createdAt: new Date() });
await users.findById(1);
await users.findAll();
await users.existsById(1);
await users.count();
await users.updateById(1, { name: 'park' });
await users.deleteById(1);
await users.deleteAll();
await users.findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc('ki');
```

## Operations

Pass `operations` to `createNPA` to observe repository SQL across PostgreSQL and
MySQL adapters. The logger receives the adapter name, SQL text, bound values,
duration, success state, and basic result counts. `onSlowQuery` fires when
`durationMs >= slowQueryThresholdMs`.

```ts
import { createNPA, NPADatabaseError } from '@node-persistence-api/core';
import { postgresql } from '@node-persistence-api/connector-pg';

const npa = createNPA({
  adapter: postgresql({ queryable: connection }),
  operations: {
    logger(event) {
      console.log(event.adapter, event.durationMs, event.text, event.values);
    },
    slowQueryThresholdMs: 100,
    onSlowQuery(event) {
      console.warn('slow query', event.durationMs, event.text);
    },
  },
});

try {
  await npa.get(UserRepository).insert(user);
} catch (error) {
  if (error instanceof NPADatabaseError) {
    console.error(error.adapter, error.code, error.text, error.values);
    throw error.cause;
  }

  throw error;
}
```

Driver failures are wrapped as `NPADatabaseError` with the original error in
`cause`. Common fields such as `code`, `constraint`, `detail`, `errno`, and
`sqlState` are copied when the driver exposes them.


## Transactions

Use a database transaction manager when multiple repository calls must commit or
roll back as one unit. Pass a transaction-capable connection to the runtime
adapter, then decorate service methods with `@Transaction()`. The default
propagation is `TransactionPropagation.REQUIRED`, so nested transactional calls
reuse the active transaction. Use
`{ propagation: TransactionPropagation.REQUIRES_NEW }` to force a separate
transaction, or `{ propagation: TransactionPropagation.NESTED }` to use a
savepoint inside the current transaction. `readOnly: true` starts a read-only
database transaction and rejects dirty-checking flushes, `persist`, and
`remove`.

```ts
import {
  TransactionIsolation,
  Transaction,
  createNPA,
} from '@node-persistence-api/core';
import { postgresql } from '@node-persistence-api/connector-pg';
import { Pool } from 'pg';
import './repositories';
import { UserRepository } from './user.repository';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const npa = createNPA({
  adapter: postgresql({ connection: pool }),
});

class UserService {
  private readonly users = npa.get(UserRepository);

  @Transaction({ isolation: TransactionIsolation.READ_COMMITTED })
  async renameUser(id: number, name: string): Promise<void> {
    await this.users.updateById(id, { name });
    await this.users.findById(id);
  }
}

const service = new UserService();
```

When multiple `NPA` instances register transaction managers, pass
`name: 'main'` to each instance and choose one explicitly with
`@Transaction({ managerName: 'main' })`.

MySQL uses the same core decorator with
`@node-persistence-api/connector-mysql`. Transaction options currently support
`isolation`, `readOnly`, `TransactionPropagation.REQUIRED`,
`TransactionPropagation.REQUIRES_NEW`, and `TransactionPropagation.NESTED`.

## Dirty Checking and Versioning

Repository results loaded inside a transaction are managed by the active
`PersistenceContext`. Mutating a managed entity and returning from the
transaction flushes changed columns before commit. If the entity has `@Version`,
NPA updates with `WHERE id = ? AND version = ?`, increments the version column,
and throws `OptimisticLockError` when no row matches the expected version.
`repository.persist(entity)` and `repository.remove(entity)` also use the active
context, so inserts and deletes flush with the transaction.

## Pagination

`findAll` accepts `pageable`. Offset pagination returns `Page<T>` with a count
query; cursor pagination returns `CursorPage<T>` with bidirectional keyset
cursors. Use `@EntityGraph` on repository methods that should return paged rows
with loaded relations.

```ts
import { Pageable, type CursorPage, type Page } from '@node-persistence-api/core';

const page: Page<User> = await users.findAll({
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

## Errors

Public NPA failures extend `NPAError`. Branch on either `instanceof` or the
stable `error.code` value.

```ts
import { NPAError, NPAPaginationError } from '@node-persistence-api/core';

try {
  await users.findAll({ pageable: Pageable.cursor({ after: cursor, size: 20 }) });
} catch (error) {
  if (error instanceof NPAPaginationError && error.code === 'NPA_INVALID_CURSOR') {
    // handle bad cursor
  }

  if (error instanceof NPAError) {
    console.error(error.code, error.details);
  }
}
```

Every NPA error has this shape:

```ts
interface NPAErrorOptions {
  code: NPAErrorCode;
  cause?: unknown;
  details?: Record<string, unknown>;
}
```

Error classes:

| Class | Domain |
| --- | --- |
| `NPAError` | base class |
| `NPAConfigurationError` | config, adapter loading, repository registration |
| `NPAMetadataError` | entity mapping, decorators, relation metadata |
| `NPAQueryError` | derived queries, raw queries, repository query validation |
| `NPAPaginationError` | offset and cursor pagination |
| `NPAMigrationError` | migration config, CLI args, safety, deploy history |
| `NPATransactionError` | transaction managers, decorators, propagation |
| `NPAPersistenceError` | persistence context, dirty checking, optimistic locking |
| `NPADatabaseError` | database and driver failures |
| `OptimisticLockError` | extends `NPAPersistenceError` |
| `RollbackOnlyError` | extends `NPATransactionError` |

Configuration codes:

| Code | Meaning |
| --- | --- |
| `NPA_CONFIG_NOT_FOUND` | explicit config file was not found |
| `NPA_INVALID_CONFIG` | config shape or adapter/url pairing is invalid |
| `NPA_UNSUPPORTED_ADAPTER` | selected adapter cannot be used |
| `NPA_ADAPTER_REQUIRED` | adapter could not be resolved |
| `NPA_CONNECTOR_EXPORT_MISSING` | connector package is missing a required export |
| `NPA_REPOSITORY_METADATA_REQUIRED` | repository metadata or registration is missing |
| `NPA_DUPLICATE_REPOSITORY` | repository was registered more than once |

Metadata and mapping codes:

| Code | Meaning |
| --- | --- |
| `NPA_ENTITY_METADATA_NOT_FOUND` | entity metadata was not registered |
| `NPA_ENTITY_ID_REQUIRED` | entity requires an `@Id` column |
| `NPA_COMPOSITE_RELATION_KEY_UNSUPPORTED` | relation target has a composite id |
| `NPA_INVALID_DECORATOR_TARGET` | decorator was used on the wrong target |
| `NPA_INVALID_DECORATOR_OPTIONS` | decorator options are invalid |
| `NPA_DUPLICATE_ENTITY_METADATA` | entity metadata was registered twice |
| `NPA_UNSUPPORTED_CASCADE_TYPE` | relation cascade option is not supported |
| `NPA_UNSUPPORTED_FETCH_TYPE` | relation fetch option is not supported |
| `NPA_UNSUPPORTED_GENERATION_STRATEGY` | id generation strategy is not supported |
| `NPA_SYMBOL_PROPERTY_UNSUPPORTED` | symbol properties cannot be mapped |

Query and repository codes:

| Code | Meaning |
| --- | --- |
| `NPA_INVALID_QUERY_METHOD` | derived query method name is invalid |
| `NPA_INVALID_QUERY_PREDICATE` | query predicate or parameter is invalid |
| `NPA_QUERY_ARGUMENT_COUNT_MISMATCH` | method arguments do not match parsed query |
| `NPA_DUPLICATE_QUERY_PREDICATE` | derived query repeats the same predicate |
| `NPA_PAGEABLE_UNSUPPORTED_QUERY` | pageable was used with a non-find query |
| `NPA_TOP_PAGEABLE_CONFLICT` | `Top` or `First` was combined with pageable |
| `NPA_RAW_QUERY_PLACEHOLDER_MISMATCH` | raw query placeholders do not match args |
| `NPA_RAW_QUERY_RESULT_MODE_UNSUPPORTED` | raw query result mode is unsupported |
| `NPA_ORDER_DIRECTION_UNSUPPORTED` | order clause is invalid or unsupported |

Pagination codes:

| Code | Meaning |
| --- | --- |
| `NPA_INVALID_PAGE_SIZE` | page size is not valid |
| `NPA_INVALID_OFFSET_PAGE` | offset page is not valid |
| `NPA_INVALID_CURSOR` | cursor cannot be decoded or has invalid shape |
| `NPA_CURSOR_METADATA_REQUIRED` | cursor query metadata is missing |
| `NPA_CURSOR_ORDER_UNSUPPORTED` | cursor order cannot be represented |
| `NPA_CURSOR_DIRECTION_CONFLICT` | `after` and `before` were both provided |

Relation codes:

| Code | Meaning |
| --- | --- |
| `NPA_RELATION_NOT_FOUND` | requested relation metadata does not exist |
| `NPA_RELATION_MAPPED_BY_REQUIRED` | inverse relation requires `mappedBy` |
| `NPA_RELATION_MAPPED_BY_NOT_FOUND` | `mappedBy` relation could not be found |
| `NPA_RELATION_TARGET_ID_REQUIRED` | relation target id is missing |
| `NPA_RELATION_PRIMARY_VALUE_REQUIRED` | relation primary value is missing |
| `NPA_TO_MANY_RELATION_ARRAY_REQUIRED` | to-many relation value is not an array |
| `NPA_UNRESOLVED_TO_ONE_DEPENDENCY` | persisted graph has unresolved to-one dependencies |
| `NPA_RELATION_LOAD_METADATA_REQUIRED` | relation loading requires entity metadata |

Persistence codes:

| Code | Meaning |
| --- | --- |
| `NPA_PRIMARY_KEY_REQUIRED` | operation requires a primary key value |
| `NPA_COMPOSITE_ID_OBJECT_REQUIRED` | composite id must be passed as an object |
| `NPA_INSERT_VALUES_REQUIRED` | insert has no values |
| `NPA_UPDATE_VALUES_REQUIRED` | update has no changed values |
| `NPA_VERSION_COLUMN_REQUIRED` | versioned update requires a version column |
| `NPA_VERSION_VALUE_REQUIRED` | versioned entity is missing its version value |
| `NPA_OPTIMISTIC_LOCK_FAILED` | optimistic lock update affected no rows |
| `NPA_READ_ONLY_TRANSACTION_WRITE` | write attempted inside a read-only transaction |
| `NPA_PERSIST_UNSUPPORTED` | adapter does not support persist for this path |
| `NPA_REMOVE_UNSUPPORTED` | adapter does not support remove for this path |
| `NPA_RELATION_SYNC_UNSUPPORTED` | adapter cannot sync relation changes |

Transaction codes:

| Code | Meaning |
| --- | --- |
| `NPA_TRANSACTION_MANAGER_NOT_FOUND` | transaction manager could not be resolved |
| `NPA_TRANSACTION_MANAGER_DUPLICATED` | named transaction manager is duplicated |
| `NPA_TRANSACTION_MANAGER_AMBIGUOUS` | multiple default transaction managers exist |
| `NPA_TRANSACTION_DECORATOR_INVALID_TARGET` | `@Transaction` was not used on a method |
| `NPA_TRANSACTION_PROPAGATION_UNSUPPORTED` | propagation mode is unsupported |
| `NPA_NESTED_TRANSACTION_UNSUPPORTED` | nested transaction savepoints are unavailable |
| `NPA_ROLLBACK_ONLY` | joined transaction was marked rollback-only |

Migration codes:

| Code | Meaning |
| --- | --- |
| `NPA_MIGRATION_DATABASE_URL_REQUIRED` | migration command requires a database url |
| `NPA_MIGRATION_RENAME_DATABASE_URL_REQUIRED` | rename planning requires a database url |
| `NPA_MIGRATION_UNSUPPORTED_COMMAND` | migration CLI command is unsupported |
| `NPA_MIGRATION_INVALID_ARGUMENT` | migration CLI argument is invalid |
| `NPA_MIGRATION_INVALID_RENAME` | `--rename` value is invalid |
| `NPA_MIGRATION_UNSAFE_STATEMENT` | destructive statement needs explicit allowance |
| `NPA_MIGRATION_LOCK_FAILED` | migration lock could not be acquired |
| `NPA_MIGRATION_CHECKSUM_MISMATCH` | applied migration file checksum changed |
| `NPA_MIGRATION_HISTORY_MISMATCH` | applied migration is missing locally |
| `NPA_MIGRATION_ENTITY_ID_REQUIRED` | migrated entity requires an id |
| `NPA_MIGRATION_SCHEMA_PARSE_FAILED` | migration entity parser failed |
| `NPA_MIGRATION_UNSUPPORTED_DDL` | migration DDL is unsupported |

Database and driver codes:

| Code | Meaning |
| --- | --- |
| `NPA_DATABASE_QUERY_FAILED` | database query failed |
| `NPA_DATABASE_UNIQUE_CONSTRAINT_FAILED` | unique constraint was violated |
| `NPA_DATABASE_FOREIGN_KEY_CONSTRAINT_FAILED` | foreign key constraint was violated |
| `NPA_DATABASE_NOT_NULL_CONSTRAINT_FAILED` | not-null constraint was violated |
| `NPA_DATABASE_INSERT_RETURN_FAILED` | insert did not return the expected row |
| `NPA_DATABASE_CONNECTION_INVALID` | database connection shape is invalid |
| `NPA_DATABASE_IDENTIFIER_INVALID` | database identifier is invalid |
| `NPA_DATABASE_TRANSACTION_CONNECTION_INVALID` | transaction connection shape is invalid |

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
- Query API: add bulk update by condition.
- Batching: add findUnique-style same-tick batching and relation-loading batching inside transaction-aware scopes.
- Relations: add safer relation mutation helpers.
- Entity mapping: add enum/json/array types, embedded value objects, column transformers, inheritance, and lifecycle hooks.
- Migrations: add data migration hooks and richer DDL for defaults/generated columns/enums.
- Transactions: add more propagation modes.
- Operations: add metrics/tracing, retry policy hooks, and clearer connection ownership docs.
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
