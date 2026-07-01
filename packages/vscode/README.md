# NPA VS Code Extension

This package is the VS Code integration shell for NPA repository method names.
It scans TypeScript entity and repository source, then delegates completion and
diagnostic decisions to `@node-persistence-api/language`.

MVP support:

- completion inside classes or interfaces extending `NPARepository<Entity, Id>`
- diagnostics for invalid `findBy`, `findOneBy`, `existsBy`, `countBy`, and
  `deleteBy` method names
- direct entity columns and one-level relation target fields
