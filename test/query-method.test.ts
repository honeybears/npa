import { describe, expect, test } from "@jest/globals";
import {
  InMemoryRepositoryExecutor,
  Query,
  createDerivedQueryRepository,
  createNPARepository,
  createQueryMethodProxy,
  parseQueryMethod,
  type NPARepositoryAdapter,
  type RepositoryRawQueryInvocation,
} from "../dist";

type DynamicRepository = Record<string, (...args: unknown[]) => unknown>;

describe("derived query methods", () => {
  test("parses a Spring Data JPA style method name into a query AST", () => {
    expect(
      parseQueryMethod(
        "findTop10ByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc",
      ),
    ).toEqual({
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
    });
  });

  test("parses distinct, first/top, ignore-case, all-ignore-case, and multi-order query methods", () => {
    expect(
      parseQueryMethod(
        "findDistinctTop5ByNameContainingIgnoreCaseAndEmailAllIgnoreCaseOrderByNameAscAgeDesc",
      ),
    ).toEqual({
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
    });

    expect(parseQueryMethod("findFirstByName").limit).toEqual(1);
    expect(parseQueryMethod("findTopByName").limit).toEqual(1);
  });

  test("parses null, not, comparison, and date alias query operators", () => {
    const parsed = parseQueryMethod(
      "findByDeletedAtIsNullAndUpdatedAtIsNotNullAndNameNotAndAgeLessThanEqualAndScoreGreaterThanEqualAndCreatedAtBeforeAndExpiresAtAfter",
    );

    expect(
      parsed.predicate.map((part) => ({
        connector: part.connector,
        property: part.condition.property,
        operator: part.condition.operator,
        parameterIndex: part.condition.parameterIndex,
      })),
    ).toEqual([
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
    ]);
    expect(parsed.parameterCount).toEqual(5);
  });

  test("rejects exact duplicate predicates before execution", () => {
    const repository = createQueryMethodProxy(
      {} as DynamicRepository,
      () => "ok",
    );

    expect(() =>
      repository.findByEmailOrEmail("a@example.com", "b@example.com"),
    ).toThrow(/duplicate predicate "email equals"/);
    expect(() =>
      repository.findByEmailAndEmail("a@example.com", "b@example.com"),
    ).toThrow(/duplicate predicate "email equals"/);
    expect(
      repository.findByEmailOrEmailContaining("a@example.com", "example.com"),
    ).toEqual("ok");
  });

  test("validates derived query parameter count before execution", () => {
    const repository = createQueryMethodProxy(
      {} as DynamicRepository,
      () => [],
    );

    expect(() => repository.findByNameAndAge("kim")).toThrow(
      /expects 2 parameter\(s\), received 1/,
    );
    expect(() => repository.findByName("kim", "extra")).toThrow(
      /expects 1 parameter\(s\), received 2/,
    );
    expect(() => repository.findByAgeBetween(1)).toThrow(
      /expects 2 parameter\(s\), received 1/,
    );
  });

  test("routes @Query repository methods through the raw query executor", async () => {
    const calls: RepositoryRawQueryInvocation[] = [];

    class RawUserRepository {
      findBySql(_name: string): Promise<unknown> {
        throw new Error("placeholder should not run");
      }
    }

    Query("SELECT * FROM users WHERE name = ?", { result: "one" })(
      RawUserRepository.prototype,
      "findBySql",
      Object.getOwnPropertyDescriptor(RawUserRepository.prototype, "findBySql"),
    );

    const adapter: NPARepositoryAdapter<object, unknown> = {
      async findById() {
        return null;
      },
      async findAll() {
        return [];
      },
      async existsById() {
        return false;
      },
      async count() {
        return 0;
      },
      async save(entity) {
        return entity;
      },
      async insert(entity) {
        return entity;
      },
      async update(entity) {
        return entity;
      },
      async updateById() {
        return null;
      },
      async delete() {
        return 0;
      },
      async deleteById() {
        return 0;
      },
      async deleteAll() {
        return 0;
      },
      async executeDerivedQuery() {
        throw new Error("derived query should not run");
      },
      async executeRawQuery(invocation) {
        calls.push(invocation);
        return { id: 1, name: invocation.args[0] };
      },
    };

    const repository = createNPARepository(
      Object.create(RawUserRepository.prototype),
      adapter,
    );

    expect(await repository.findBySql("kim")).toEqual({ id: 1, name: "kim" });
    expect(calls).toEqual([
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
      } as {
        save(entity: (typeof rows)[number]): (typeof rows)[number];
      } & DynamicRepository,
      executor.execute,
    );

    expect(repository.save({ id: 2, name: "lee", age: 30 })).toEqual({
      id: 2,
      name: "lee",
      age: 30,
    });
    expect(repository.findByName("lee")).toEqual([
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
    const repository = createDerivedQueryRepository(
      {} as DynamicRepository,
      executor.execute,
    );

    expect(
      repository.findByNameContainingAndAgeGreaterThanOrderByCreatedAtDesc(
        "kim",
        20,
      ),
    ).toEqual([rows[2], rows[0]]);
    expect(repository.existsByActiveFalseAndNameStartingWith("park")).toEqual(
      true,
    );
    expect(repository.countByAgeBetween(25, 35)).toEqual(2);
    expect(repository.findByNameContainingIgnoreCase("KIM")).toEqual([
      rows[0],
      rows[2],
    ]);
    expect(repository.deleteByStatusIn(["inactive", "blocked"])).toEqual(2);
    expect(rows).toEqual([
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
    const repository = createDerivedQueryRepository(
      {} as DynamicRepository,
      executor.execute,
    );

    expect(repository.findByStatus(null)).toEqual([rows[0]]);
    expect(repository.findByNameIsNull()).toEqual([rows[2]]);
    expect(repository.findByStatusIsNotNull()).toEqual([rows[1], rows[2]]);
    expect(() => repository.findByStatusIn("active")).toThrow(
      /expects an array parameter/,
    );
    expect(() => repository.findByStatusIn([])).toThrow(
      /expects a non-empty array parameter/,
    );
    expect(() => repository.findByStatusNotIn([])).toThrow(
      /expects a non-empty array parameter/,
    );
    expect(() => repository.findByStatus(undefined)).toThrow(
      /must not be undefined/,
    );
  });
});
