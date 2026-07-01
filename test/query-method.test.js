const assert = require("node:assert/strict");
const test = require("node:test");

const {
  InMemoryRepositoryExecutor,
  createDerivedQueryRepository,
  createQueryMethodProxy,
  parseQueryMethod,
} = require("../dist");

test("parses a Spring Data JPA style method name into a query AST", () => {
  assert.deepEqual(
    parseQueryMethod(
      "findTop10ByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc",
    ),
    {
      methodName:
        "findTop10ByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc",
      action: "find",
      limit: 10,
      predicate: [
        {
          condition: {
            property: "name",
            operator: "containing",
            parameterIndex: 0,
          },
        },
        {
          connector: "and",
          condition: {
            property: "age",
            operator: "greaterThan",
            parameterIndex: 1,
          },
        },
      ],
      orderBy: [{ property: "createdAt", direction: "desc" }],
      parameterCount: 2,
    },
  );
});

test("parses distinct, first/top, ignore-case, all-ignore-case, and multi-order query methods", () => {
  assert.deepEqual(
    parseQueryMethod(
      "findDistinctTop5ByNameContainingIgnoreCaseAndEmailAllIgnoreCaseOrderByNameAscAgeDesc",
    ),
    {
      methodName:
        "findDistinctTop5ByNameContainingIgnoreCaseAndEmailAllIgnoreCaseOrderByNameAscAgeDesc",
      action: "find",
      distinct: true,
      allIgnoreCase: true,
      limit: 5,
      predicate: [
        {
          condition: {
            property: "name",
            operator: "containing",
            parameterIndex: 0,
            ignoreCase: true,
          },
        },
        {
          connector: "and",
          condition: {
            property: "email",
            operator: "equals",
            parameterIndex: 1,
          },
        },
      ],
      orderBy: [
        { property: "name", direction: "asc" },
        { property: "age", direction: "desc" },
      ],
      parameterCount: 2,
    },
  );

  assert.equal(parseQueryMethod("findFirstByName").limit, 1);
  assert.equal(parseQueryMethod("findTopByName").limit, 1);
});

test("validates derived query parameter count before execution", () => {
  const repository = createQueryMethodProxy({}, () => []);

  assert.throws(
    () => repository.findByNameAndAge("kim"),
    /expects 2 parameter\(s\), received 1/,
  );
});

test("keeps concrete repository methods and derives missing query methods", () => {
  const rows = [{ id: 1, name: "kim", age: 20 }];
  const executor = new InMemoryRepositoryExecutor(rows);
  const repository = createDerivedQueryRepository(
    {
      save(entity) {
        rows.push(entity);
        return entity;
      },
    },
    executor.execute,
  );

  assert.deepEqual(repository.save({ id: 2, name: "lee", age: 30 }), {
    id: 2,
    name: "lee",
    age: 30,
  });
  assert.deepEqual(repository.findByName("lee"), [
    { id: 2, name: "lee", age: 30 },
  ]);
});

test("executes find, exists, count, and delete query methods in memory", () => {
  const rows = [
    {
      id: 1,
      name: "kim alpha",
      age: 32,
      active: true,
      status: "active",
      createdAt: 1,
    },
    {
      id: 2,
      name: "park beta",
      age: 28,
      active: false,
      status: "inactive",
      createdAt: 3,
    },
    {
      id: 3,
      name: "kim gamma",
      age: 41,
      active: false,
      status: "blocked",
      createdAt: 2,
    },
  ];
  const executor = new InMemoryRepositoryExecutor(rows);
  const repository = createDerivedQueryRepository({}, executor.execute);

  assert.deepEqual(
    repository.findByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc(
      "kim",
      20,
    ),
    [rows[2], rows[0]],
  );
  assert.equal(repository.existsByActiveFalseAndNameStartingWith("park"), true);
  assert.equal(repository.countByAgeBetween(25, 35), 2);
  assert.deepEqual(repository.findByNameContainingIgnoreCase("KIM"), [
    rows[0],
    rows[2],
  ]);
  assert.equal(repository.deleteByStatusIn(["inactive", "blocked"]), 2);
  assert.deepEqual(rows, [
    {
      id: 1,
      name: "kim alpha",
      age: 32,
      active: true,
      status: "active",
      createdAt: 1,
    },
  ]);
});
