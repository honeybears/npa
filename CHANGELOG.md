# Changelog

## 0.1.0-beta.1 - 2026-07-03

### Added

- Added SQL operation hooks through `createNPA({ operations })`.
  - `logger(event)` receives the adapter name, SQL text, bound values, duration, success state, and basic result counts.
  - `slowQueryThresholdMs` and `onSlowQuery(event)` can be used to observe slow repository queries.
  - PostgreSQL and MySQL repository execution now share the same query-event shape.
- Added `NPADatabaseError` for normalized database driver failures.
  - Preserves the original driver error in `cause`.
  - Copies common driver fields such as `code`, `constraint`, `detail`, `errno`, and `sqlState` when available.
  - Includes SQL text and bound values on the thrown error for easier debugging.
- Added composite relation key support.
  - Owning `@ManyToOne` and owning `@OneToOne` relations can target entities with multiple `@Id` columns.
  - Added `joinColumns` relation metadata for explicit composite foreign-key column names.
  - PostgreSQL and MySQL CRUD compilers expand composite relation values into multiple foreign-key columns.
  - Derived queries such as `findByTeam(...)` and `findByTeamIn(...)` support composite relation predicates.
  - Relation-field joins such as `findByTeamLabel(...)` use all composite join columns.
  - Lazy/eager relation loaders support composite keys across to-one, one-to-many, one-to-one, and many-to-many paths.
  - Many-to-many join tables support composite primary keys on either side.
  - Migration schema parsing, checksums, and generated PostgreSQL/MySQL DDL include composite relation foreign keys.
- Added inverse and owning `@OneToOne` relation support across metadata, migrations, relation loading, and derived relation queries.
- Added cursor pagination support for projection queries.
  - Projection `findAll({ select, pageable: Pageable.cursor(...) })` now carries hidden cursor columns when needed.
  - Cursor ordering can follow scalar fields and supported to-one relation chains.
- Added adapter-wired transaction managers.
  - PostgreSQL and MySQL adapters can register transaction managers through `createNPA`.
  - Multiple `NPA` instances can register named transaction managers.
- Added nested transaction savepoint support.
  - `TransactionPropagation.NESTED` uses database savepoints for PostgreSQL and MySQL.
  - Persistence context behavior was updated so nested rollback boundaries do not leak dirty state.

### Changed

- Public examples and README snippets now prefer `createNPA(...)` instead of constructing `new NPA(...)` directly.
- PostgreSQL and MySQL connector README files were aligned with the `createNPA` usage flow.
- Relation utilities now expose array-based helpers for composite join columns while preserving single-column helpers for existing callers.
- Persistence context identity tracking now supports composite ids for managed entities, dirty flushes, relation snapshots, and cascading relation operations.
- PostgreSQL and MySQL many-to-many sync/delete logic now expands id values in entity primary-key declaration order.
- README operations guidance now documents SQL logging, slow-query hooks, and `NPADatabaseError`.
- README relation guidance now documents composite relation foreign keys and `joinColumns`.

### Fixed

- Fixed relation loaders and query builders that assumed relation keys always map to one column.
- Fixed dirty-check comparisons so composite relation ids are compared structurally without treating ordinary JSON/object columns as ids.
- Fixed many-to-many lazy/eager loading to preserve the existing single-column source alias while supporting composite aliases.
- Fixed packed package release guidance to keep npm package release separate from VS Code Marketplace release.

### Validation

- Added PostgreSQL and MySQL adapter tests for SQL operation hooks and normalized driver errors.
- Added real database E2E coverage proving repository SQL logging against PostgreSQL and MySQL.
- Added PostgreSQL and MySQL adapter tests for composite relation inserts, direct relation predicates, relation-field joins, and composite `IN` predicates.
- Added migration tests for composite relation foreign keys in PostgreSQL and MySQL DDL.
- Verified the latest implementation with:
  - `npm run build`
  - PostgreSQL adapter tests
  - MySQL adapter tests
  - `test/e2e/database-adapters.test.ts`

