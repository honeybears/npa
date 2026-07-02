const assert = require("node:assert/strict");
const test = require("node:test");

const {
  InMemoryRepositoryExecutor,
  Query,
  createDerivedQueryRepository,
  createNPARepository,
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

test("parses null, not, comparison, and date alias query operators", () => {
  const parsed = parseQueryMethod(
    "findByDeletedAtIsNullAndUpdatedAtIsNotNullAndNameNotAndAgeLessThanEqualAndScoreGreaterThanEqualAndCreatedAtBeforeAndExpiresAtAfter",
  );

  assert.deepEqual(
    parsed.predicate.map((part) => ({
      connector: part.connector,
      property: part.condition.property,
      operator: part.condition.operator,
      parameterIndex: part.condition.parameterIndex,
    })),
    [
      {
        connector: undefined,
        property: "deletedAt",
        operator: "isNull",
        parameterIndex: undefined,
      },
      {
        connector: "and",
        property: "updatedAt",
        operator: "isNotNull",
        parameterIndex: undefined,
      },
      {
        connector: "and",
        property: "name",
        operator: "not",
        parameterIndex: 0,
      },
      {
        connector: "and",
        property: "age",
        operator: "lessThanEqual",
        parameterIndex: 1,
      },
      {
        connector: "and",
        property: "score",
        operator: "greaterThanEqual",
        parameterIndex: 2,
      },
      {
        connector: "and",
        property: "createdAt",
        operator: "lessThan",
        parameterIndex: 3,
      },
      {
        connector: "and",
        property: "expiresAt",
        operator: "greaterThan",
        parameterIndex: 4,
      },
    ],
  );
  assert.equal(parsed.parameterCount, 5);
});

test("rejects exact duplicate predicates before execution", () => {
  const repository = createQueryMethodProxy({}, () => "ok");

  assert.throws(
    () => repository.findByEmailOrEmail("a@example.com", "b@example.com"),
    /duplicate predicate "email equals"/,
  );
  assert.throws(
    () => repository.findByEmailAndEmail("a@example.com", "b@example.com"),
    /duplicate predicate "email equals"/,
  );
  assert.equal(
    repository.findByEmailOrEmailContaining("a@example.com", "example.com"),
    "ok",
  );
});

test("validates derived query parameter count before execution", () => {
  const repository = createQueryMethodProxy({}, () => []);

  assert.throws(
    () => repository.findByNameAndAge("kim"),
    /expects 2 parameter\(s\), received 1/,
  );
  assert.throws(
    () => repository.findByName("kim", "extra"),
    /expects 1 parameter\(s\), received 2/,
  );
  assert.throws(
    () => repository.findByAgeBetween(1),
    /expects 2 parameter\(s\), received 1/,
  );
});

test("routes @Query repository methods through the raw query executor", async () => {
  const calls = [];

  class RawUserRepository {
    findBySql() {
      throw new Error("placeholder should not run");
    }
  }

  Query("SELECT * FROM users WHERE name = ?", { result: "one" })(
    RawUserRepository.prototype,
    "findBySql",
    Object.getOwnPropertyDescriptor(RawUserRepository.prototype, "findBySql"),
  );

  const adapter = {
    findById() {},
    findAll() {},
    existsById() {},
    count() {},
    save() {},
    insert() {},
    update() {},
    updateById() {},
    delete() {},
    deleteById() {},
    deleteAll() {},
    executeDerivedQuery() {
      throw new Error("derived query should not run");
    },
    executeRawQuery(invocation) {
      calls.push(invocation);
      return { id: 1, name: invocation.args[0] };
    },
  };

  const repository = createNPARepository(
    Object.create(RawUserRepository.prototype),
    adapter,
  );

  assert.deepEqual(await repository.findBySql("kim"), { id: 1, name: "kim" });
  assert.deepEqual(calls, [
    {
      query: {
        text: "SELECT * FROM users WHERE name = ?",
        result: "one",
        managed: false,
      },
      methodName: "findBySql",
      args: ["kim"],
    },
  ]);
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

test("handles null and empty list query parameters in memory", () => {
  const rows = [
    { id: 1, name: "desk", status: null },
    { id: 2, name: "chair", status: "active" },
    { id: 3, name: undefined, status: "archived" },
  ];
  const executor = new InMemoryRepositoryExecutor(rows);
  const repository = createDerivedQueryRepository({}, executor.execute);

  assert.deepEqual(repository.findByStatus(null), [rows[0]]);
  assert.deepEqual(repository.findByNameIsNull(), [rows[2]]);
  assert.deepEqual(repository.findByStatusIsNotNull(), [rows[1], rows[2]]);
  assert.throws(
    () => repository.findByStatusIn("active"),
    /expects an array parameter/,
  );
  assert.throws(
    () => repository.findByStatusIn([]),
    /expects a non-empty array parameter/,
  );
  assert.throws(
    () => repository.findByStatusNotIn([]),
    /expects a non-empty array parameter/,
  );
  assert.throws(
    () => repository.findByStatus(undefined),
    /must not be undefined/,
  );
});
