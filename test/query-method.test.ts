import { describe, expect, test } from "@jest/globals";
import {
  EntityGraph,
  InMemoryRepositoryExecutor,
  Pageable,
  Query,
  createDerivedQueryRepository,
  createNPARepository,
  createQueryMethodProxy,
  defineEntityGraph,
  parseQueryMethod,
  type Loaded,
  type NPARepositoryAdapter,
  type Relation,
  type RepositoryMethodInvocation,
  type RepositoryRawQueryInvocation,
} from "../src";

type DynamicRepository = Record<string, (...args: unknown[]) => unknown>;

interface GraphOrganization {
  name: string;
}

interface GraphTeam {
  label: string;
  organization: Relation<GraphOrganization>;
}

interface GraphRole {
  name: string;
}

interface GraphMember {
  name: string;
  team: Relation<GraphTeam>;
  roles: Relation<GraphRole[]>;
}

const memberGraph = defineEntityGraph<GraphMember>({
  team: {
    organization: true,
  },
  roles: true,
});

describe("derived query methods", () => {
  test("narrows loaded relation fields from graph selections", () => {
    const member = {
      name: "kim",
      team: {
        label: "core",
        organization: { name: "platform" },
      },
      roles: [{ name: "admin" }],
    } satisfies Loaded<GraphMember, typeof memberGraph>;

    expect(memberGraph.roles).toEqual(true);
    expect(member.team.organization.name).toEqual("platform");
    expect(member.roles[0].name).toEqual("admin");
  });

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

  test("accepts Pageable as the last derived find query argument", () => {
    const lowLevelCalls: unknown[] = [];
    const lowLevelRepository = createQueryMethodProxy(
      {} as DynamicRepository,
      (query, args, pageableArg) => {
        lowLevelCalls.push({ query, args, pageable: pageableArg });
        return [];
      },
    );
    const calls: RepositoryMethodInvocation[] = [];
    const repository = createDerivedQueryRepository(
      {} as DynamicRepository,
      (invocation) => {
        calls.push(invocation);
        return [];
      },
    );
    const pageable = Pageable.offset(0, 10);

    expect(lowLevelRepository.findByName("kim", pageable)).toEqual([]);
    expect(lowLevelCalls[0]).toMatchObject({
      args: ["kim"],
      pageable,
    });
    expect(repository.findByName("kim", pageable)).toEqual([]);
    expect(calls[0]).toMatchObject({
      args: ["kim"],
      pageable,
    });
    expect(() => repository.findTop2ByName("kim", pageable)).toThrow(
      /cannot combine First\/Top with Pageable/,
    );
    expect(() => repository.countByName("kim", pageable)).toThrow(
      /only supports Pageable on find queries/,
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
      async persist(entity) {
        return entity;
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
      async remove() {},
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

  test("passes @EntityGraph only when a repository method declares it", () => {
    const calls: RepositoryMethodInvocation[] = [];

    abstract class UserRepository {
      @EntityGraph(["team"])
      abstract findByName: (name: string) => unknown[];
    }

    const repository = createDerivedQueryRepository(
      Object.create(UserRepository.prototype) as DynamicRepository,
      (invocation) => {
        calls.push(invocation);
        return [];
      },
    );

    expect(repository.findByName("kim")).toEqual([]);
    expect(repository.findByAge(20)).toEqual([]);
    expect(calls[0].entityGraph).toEqual({ relations: ["team"] });
    expect("entityGraph" in calls[1]).toEqual(false);
  });

  test("uses explicit @EntityGraph defaults for base read methods", async () => {
    const loads: unknown[] = [];

    abstract class UserRepository {
      @EntityGraph(["team"])
      abstract findById: (id: number) => Promise<object | null>;

      @EntityGraph(["team"])
      abstract findAll: (options?: object) => Promise<object[]>;
    }

    const adapter: NPARepositoryAdapter<object, number> = {
      async findById(id, load) {
        loads.push(load);
        return { id };
      },
      async findAll(load) {
        loads.push(load);
        return [];
      },
      async existsById() {
        return false;
      },
      async count() {
        return 0;
      },
      async persist(entity) {
        return entity;
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
      async remove() {},
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
    };
    const repository = createNPARepository(
      Object.create(UserRepository.prototype),
      adapter,
    );

    await repository.findById(1);
    await repository.findById(2, { relations: ["roles"] });
    await repository.findAll({
      orderBy: [{ property: "name", direction: "desc" }],
      pageable: Pageable.offset(0, 10),
    });
    expect(loads).toEqual([
      { relations: ["team"] },
      { relations: ["team", "roles"] },
      {
        relations: ["team"],
        orderBy: [{ property: "name", direction: "desc" }],
        pageable: Pageable.offset(0, 10),
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

  test("executes offset and bidirectional cursor pages in memory", () => {
    const rows = [
      {
        id: 1,
        name: "a",
        status: "active",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: 2,
        name: "b",
        status: "active",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: 3,
        name: "c",
        status: "active",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        id: 4,
        name: "d",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const executor = new InMemoryRepositoryExecutor(rows);
    const repository = createDerivedQueryRepository(
      {} as DynamicRepository,
      executor.execute,
    );

    expect(
      repository.findByStatusOrderByCreatedAtDesc(
        "active",
        Pageable.offset(1, 2),
      ),
    ).toMatchObject({
      content: [rows[2], rows[3]],
      page: 1,
      size: 2,
      totalElements: 4,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });

    const firstPage = repository.findByStatusOrderByCreatedAtDesc(
      "active",
      Pageable.cursor({ size: 2 }),
    ) as { content: typeof rows; nextCursor: string; previousCursor: string | null };
    const secondPage = repository.findByStatusOrderByCreatedAtDesc(
      "active",
      Pageable.cursor({ after: firstPage.nextCursor, size: 2 }),
    ) as { content: typeof rows; previousCursor: string };
    const previousPage = repository.findByStatusOrderByCreatedAtDesc(
      "active",
      Pageable.cursor({ before: secondPage.previousCursor, size: 2 }),
    ) as { content: typeof rows };

    expect(firstPage.content).toEqual([rows[0], rows[1]]);
    expect(firstPage.previousCursor).toEqual(null);
    expect(secondPage.content).toEqual([rows[2], rows[3]]);
    expect(previousPage.content).toEqual([rows[0], rows[1]]);
  });

  test("executes find projections with order and offset pages in memory", () => {
    const rows = [
      { id: 1, name: "kim", age: 32 },
      { id: 2, name: "lee", age: 28 },
      { id: 3, name: "park", age: 41 },
    ];
    const executor = new InMemoryRepositoryExecutor(rows);

    expect(
      executor.execute({
        query: {
          methodName: "findAll",
          action: "find",
          predicate: [],
          orderBy: [{ property: "name", direction: "desc" }],
          parameterCount: 0,
        },
        args: [],
        select: ["id", "name"],
      }),
    ).toEqual([
      { id: 3, name: "park" },
      { id: 2, name: "lee" },
      { id: 1, name: "kim" },
    ]);

    expect(
      executor.execute({
        query: {
          methodName: "findAll",
          action: "find",
          predicate: [],
          orderBy: [{ property: "name", direction: "asc" }],
          parameterCount: 0,
        },
        args: [],
        select: ["name"],
        pageable: Pageable.offset(1, 1),
      }),
    ).toMatchObject({
      content: [{ name: "lee" }],
      totalElements: 3,
      totalPages: 3,
    });

    const firstCursorPage = executor.execute({
      query: {
        methodName: "findAll",
        action: "find",
        predicate: [],
        orderBy: [{ property: "name", direction: "asc" }],
        parameterCount: 0,
      },
      args: [],
      select: ["name"],
      pageable: Pageable.cursor({ size: 2 }),
    });

    expect((firstCursorPage as { content: unknown[] }).content).toEqual([
      { name: "kim" },
      { name: "lee" },
    ]);
    expect((firstCursorPage as { hasNextPage: boolean }).hasNextPage).toEqual(true);

    const secondCursorPage = executor.execute({
      query: {
        methodName: "findAll",
        action: "find",
        predicate: [],
        orderBy: [{ property: "name", direction: "asc" }],
        parameterCount: 0,
      },
      args: [],
      select: ["name"],
      pageable: Pageable.cursor({
        after: (firstCursorPage as { nextCursor: string }).nextCursor,
        size: 2,
      }),
    }) as { content: unknown[]; hasNextPage: boolean };
    expect(secondCursorPage.content).toEqual([{ name: "park" }]);
    expect(secondCursorPage.hasNextPage).toEqual(false);

    expect(() =>
      executor.execute({
        query: {
          methodName: "findAll",
          action: "find",
          predicate: [],
          orderBy: [],
          parameterCount: 0,
        },
        args: [],
        select: [],
      }),
    ).toThrow(/Select projection requires at least one property/);
  });
});
