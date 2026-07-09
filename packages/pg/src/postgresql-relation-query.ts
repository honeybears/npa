import {
  defaultJoinTableName,
  EntityMetadata,
  getEntityMetadata,
  getOptionalEntityMetadata,
  joinTableColumnNames,
  relationJoinColumns,
  NPAMetadataError,
  NPAPaginationError,
  NPAQueryError,
  RelationKind,
  RelationMetadata,
} from "@node-persistence-api/core/adapter";
import { ParsedQueryMethod } from "@node-persistence-api/core/adapter";
import {
  primaryKeyProperty,
  propertyToColumn,
  propertyToColumns,
  propertyToColumnName,
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteTable,
} from "./postgresql-identifiers";
import { PostgresqlQueryCompilerOptions } from "./types";

interface RelationFieldPath {
  segments: RelationFieldSegment[];
  targetMetadata: EntityMetadata;
  targetProperty: string;
}

interface RelationFieldSegment {
  key: string;
  relation: RelationMetadata;
  sourceMetadata: EntityMetadata;
  targetMetadata: EntityMetadata;
}

interface RelationJoin {
  key: string;
  relation: RelationMetadata;
  targetMetadata: EntityMetadata;
  targetAlias: string;
  joinAlias?: string;
  selectJoins: string[];
  deleteUsingTables: string[];
  deleteJoinPredicates: string[];
}

export class PostgresqlRelationQueryBuilder {
  private readonly metadata = getOptionalEntityMetadata(this.options.entity);
  private readonly joins = new Map<string, RelationJoin>();
  private nextAlias = 1;

  readonly baseAlias = quoteIdentifier("t0");

  constructor(private readonly options: PostgresqlQueryCompilerOptions) {}

  prepare(query: ParsedQueryMethod, extraProperties: readonly string[] = []): void {
    for (const part of query.predicate) {
      this.prepareProperty(part.condition.property);
    }

    for (const order of query.orderBy) {
      this.prepareProperty(order.property);
    }

    for (const property of extraProperties) {
      this.prepareProperty(property);
    }
  }

  hasJoins(): boolean {
    return this.joins.size > 0;
  }

  selectTarget(): string {
    return this.hasJoins() ? `${this.baseAlias}.*` : "*";
  }

  countDistinctTarget(): string {
    const primaryKey = propertyToColumn(primaryKeyProperty(this.options), this.options);
    return this.hasJoins() ? `${this.baseAlias}.${primaryKey}` : primaryKey;
  }

  selectFrom(): string {
    if (!this.hasJoins()) {
      return quoteTable(this.options);
    }

    return `${quoteTable(this.options)} AS ${this.baseAlias}${this.selectJoinSql()}`;
  }

  deleteTarget(): string {
    if (!this.hasJoins()) {
      return quoteTable(this.options);
    }

    return `${quoteTable(this.options)} AS ${this.baseAlias}`;
  }

  deleteUsing(): string {
    const using = this.deleteUsingTables();
    return using.length > 0 ? ` USING ${using.join(", ")}` : "";
  }

  deleteJoinPredicates(): string[] {
    return [...this.joins.values()].flatMap((join) => join.deleteJoinPredicates);
  }

  column(property: string): string {
    const columns = this.columns(property);

    if (columns.length !== 1) {
      throw new Error(`Property ${property} maps to multiple columns.`);
    }

    return columns[0];
  }

  columns(property: string): string[] {
    const relationPath = this.resolveRelationFieldPath(property);

    if (relationPath) {
      const join = this.ensureJoinPath(relationPath);
      return [`${join.targetAlias}.${propertyToColumn(relationPath.targetProperty, {
        entity: relationPath.targetMetadata.target,
      })}`];
    }

    const columns = propertyToColumns(property, this.options);
    return this.hasJoins()
      ? columns.map((column) => `${this.baseAlias}.${column}`)
      : columns;
  }

  cursorOrder(
    property: string,
    resultKey: string,
  ): { expression: string; resultKey: string; hidden?: boolean; select?: string } {
    const relationPath = this.resolveRelationFieldPath(property);

    if (!relationPath) {
      return {
        expression: this.column(property),
        resultKey: propertyToColumnName(property, this.options),
      };
    }

    if (relationPath.segments.some((segment) => !isToOneRelation(segment.relation))) {
      throw new NPAPaginationError("Cursor pagination only supports scalar or @ManyToOne OrderBy properties; @OneToOne is also supported.", {
        code: "NPA_CURSOR_ORDER_UNSUPPORTED",
      });
    }

    const expression = this.column(property);
    return {
      expression,
      resultKey,
      hidden: true,
      select: `${expression} AS ${quoteIdentifier(resultKey)}`,
    };
  }

  private prepareProperty(property: string): void {
    const relationPath = this.resolveRelationFieldPath(property);

    if (relationPath) {
      this.ensureJoinPath(relationPath);
    }
  }

  private resolveRelationFieldPath(property: string): RelationFieldPath | undefined {
    if (!this.metadata || this.isDirectProperty(property)) {
      return undefined;
    }

    let currentMetadata = this.metadata;
    let remaining = property;
    const segments: RelationFieldSegment[] = [];

    while (true) {
      if (segments.length > 0) {
        const targetProperty = lowerFirst(remaining);

        if (currentMetadata.columns.some((column) => column.propertyName === targetProperty)) {
          return { segments, targetMetadata: currentMetadata, targetProperty };
        }
      }

      const relation = findRelationPrefix(currentMetadata, remaining);

      if (!relation) {
        if (segments.length === 0) {
          return undefined;
        }

        throw new NPAQueryError(
          `Relation query ${this.metadata.target.name}.${property} targets ${currentMetadata.target.name}.${lowerFirst(remaining)}, but that property is not a column.`,
          {
            code: "NPA_INVALID_QUERY_PREDICATE",
            details: { entity: this.metadata.target.name, property },
          },
        );
      }

      const targetMetadata = getEntityMetadata(relation.target());
      const key = [...segments.map((segment) => segment.relation.propertyName), relation.propertyName].join(".");
      segments.push({
        key,
        relation,
        sourceMetadata: currentMetadata,
        targetMetadata,
      });
      currentMetadata = targetMetadata;
      remaining = lowerFirst(remaining.slice(relation.propertyName.length));
    }
  }

  private isDirectProperty(property: string): boolean {
    return Boolean(
      this.options.columns?.[property] ??
        this.metadata?.columns.some((column) => column.propertyName === property) ??
        this.metadata?.relations.some(
          (relation) => isOwningToOneRelation(relation) && relation.propertyName === property,
        ),
    );
  }

  private ensureJoinPath(path: RelationFieldPath): RelationJoin {
    let sourceAlias = this.baseAlias;
    let join: RelationJoin | undefined;

    for (const segment of path.segments) {
      join = this.ensureJoin(segment, sourceAlias);
      sourceAlias = join.targetAlias;
    }

    return join as RelationJoin;
  }

  private ensureJoin(
    segment: RelationFieldSegment,
    sourceAlias: string,
  ): RelationJoin {
    const current = this.joins.get(segment.key);

    if (current) {
      return current;
    }

    const join = this.createJoin(segment, sourceAlias);
    this.joins.set(join.key, join);
    return join;
  }

  private createJoin(
    segment: RelationFieldSegment,
    sourceAlias: string,
  ): RelationJoin {
    const {
      key,
      relation,
      sourceMetadata,
      targetMetadata,
    } = segment;

    const targetAlias = this.nextQuotedAlias();
    const targetTable = qualifiedTable(targetMetadata);

    if (isOwningToOneRelation(relation)) {
      const joinPredicate = relationJoinColumns(relation)
        .map(({ column, joinColumnName }) =>
          `${qualifiedColumn(sourceAlias, joinColumnName)} = ${qualifiedColumn(targetAlias, column.columnName)}`)
        .join(" AND ");

      return {
        key,
        relation,
        targetMetadata,
        targetAlias,
        selectJoins: [` JOIN ${targetTable} AS ${targetAlias} ON ${joinPredicate}`],
        deleteUsingTables: [`${targetTable} AS ${targetAlias}`],
        deleteJoinPredicates: [joinPredicate],
      };
    }

    if (relation.kind === RelationKind.ONE_TO_MANY || relation.kind === RelationKind.ONE_TO_ONE) {
      const targetRelation = findMappedOwningToOne(sourceMetadata, targetMetadata, relation);
      const joinPredicate = relationJoinColumns(targetRelation)
        .map(({ column, joinColumnName }) =>
          `${qualifiedColumn(targetAlias, joinColumnName)} = ${qualifiedColumn(sourceAlias, column.columnName)}`)
        .join(" AND ");

      return {
        key,
        relation,
        targetMetadata,
        targetAlias,
        selectJoins: [` JOIN ${targetTable} AS ${targetAlias} ON ${joinPredicate}`],
        deleteUsingTables: [`${targetTable} AS ${targetAlias}`],
        deleteJoinPredicates: [joinPredicate],
      };
    }

    const joinAlias = this.nextQuotedAlias();
    const joinTable = qualifiedJoinTable(sourceMetadata, targetMetadata, relation);
    const sourcePredicate = joinTableColumnNames(sourceMetadata)
      .map(({ column, joinColumnName }) =>
        `${qualifiedColumn(joinAlias, joinColumnName)} = ${qualifiedColumn(sourceAlias, column.columnName)}`)
      .join(" AND ");
    const targetPredicate = joinTableColumnNames(targetMetadata)
      .map(({ column, joinColumnName }) =>
        `${qualifiedColumn(targetAlias, column.columnName)} = ${qualifiedColumn(joinAlias, joinColumnName)}`)
      .join(" AND ");

    return {
      key,
      relation,
      targetMetadata,
      targetAlias,
      joinAlias,
      selectJoins: [
        ` JOIN ${joinTable} AS ${joinAlias} ON ${sourcePredicate}`,
        ` JOIN ${targetTable} AS ${targetAlias} ON ${targetPredicate}`,
      ],
      deleteUsingTables: [`${joinTable} AS ${joinAlias}`, `${targetTable} AS ${targetAlias}`],
      deleteJoinPredicates: [sourcePredicate, targetPredicate],
    };
  }

  private selectJoinSql(): string {
    return [...this.joins.values()].flatMap((join) => join.selectJoins).join("");
  }

  private deleteUsingTables(): string[] {
    return [...this.joins.values()].flatMap((join) => join.deleteUsingTables);
  }

  private nextQuotedAlias(): string {
    const alias = quoteIdentifier(`t${this.nextAlias}`);
    this.nextAlias += 1;
    return alias;
  }
}

function isRelationPrefix(property: string, relationProperty: string): boolean {
  const next = property[relationProperty.length];
  return property.startsWith(relationProperty) && next !== undefined && next === next.toUpperCase();
}

function findRelationPrefix(
  metadata: EntityMetadata,
  property: string,
): RelationMetadata | undefined {
  return [...metadata.relations]
    .sort((left, right) => right.propertyName.length - left.propertyName.length)
    .find((candidate) => isRelationPrefix(property, candidate.propertyName));
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function qualifiedColumn(alias: string, columnName: string): string {
  return `${alias}.${quoteIdentifier(columnName)}`;
}

function qualifiedTable(metadata: EntityMetadata): string {
  const table = quoteQualifiedIdentifier(metadata.tableName);
  return metadata.schema ? `${quoteQualifiedIdentifier(metadata.schema)}.${table}` : table;
}

function qualifiedJoinTable(
  source: EntityMetadata,
  target: EntityMetadata,
  relation: RelationMetadata,
): string {
  const rawName = relation.joinTable ?? defaultJoinTableName(source, target);
  const separatorIndex = rawName.indexOf(".");

  if (separatorIndex > 0) {
    return `${quoteQualifiedIdentifier(rawName.slice(0, separatorIndex))}.${quoteQualifiedIdentifier(rawName.slice(separatorIndex + 1))}`;
  }

  const table = quoteQualifiedIdentifier(rawName);
  const schema = source.schema ?? target.schema;
  return schema ? `${quoteQualifiedIdentifier(schema)}.${table}` : table;
}

function findMappedOwningToOne(
  sourceMetadata: EntityMetadata,
  targetMetadata: EntityMetadata,
  relation: RelationMetadata,
): RelationMetadata {
  if (!relation.mappedBy) {
    throw new NPAMetadataError(`@${relation.kind === RelationKind.ONE_TO_ONE ? "OneToOne" : "OneToMany"} ${sourceMetadata.target.name}.${relation.propertyName} requires mappedBy.`, {
      code: "NPA_RELATION_MAPPED_BY_REQUIRED",
      details: { entity: sourceMetadata.target.name, relation: relation.propertyName },
    });
  }

  const targetRelation = targetMetadata.relations.find(
    (candidate) => isOwningToOneRelation(candidate) && candidate.propertyName === relation.mappedBy,
  );

  if (!targetRelation) {
    throw new NPAMetadataError(`@${relation.kind === RelationKind.ONE_TO_ONE ? "OneToOne" : "OneToMany"} ${sourceMetadata.target.name}.${relation.propertyName} mappedBy relation was not found.`, {
      code: "NPA_RELATION_MAPPED_BY_NOT_FOUND",
      details: { entity: sourceMetadata.target.name, relation: relation.propertyName, mappedBy: relation.mappedBy },
    });
  }

  return targetRelation;
}

function isOwningToOneRelation(relation: RelationMetadata): boolean {
  return relation.kind === RelationKind.MANY_TO_ONE ||
    (relation.kind === RelationKind.ONE_TO_ONE && !relation.mappedBy);
}

function isToOneRelation(relation: RelationMetadata): boolean {
  return relation.kind === RelationKind.MANY_TO_ONE ||
    relation.kind === RelationKind.ONE_TO_ONE;
}
