import {
  defaultJoinTableName,
  EntityMetadata,
  getEntityMetadata,
  getOptionalEntityMetadata,
  joinTableColumnName,
  relationJoinColumnName,
  RelationKind,
  RelationMetadata,
} from "@node-persistence-api/core";
import { ParsedQueryMethod } from "@node-persistence-api/core";
import {
  mysqlPrimaryKeyProperty,
  mysqlPropertyToColumn,
  quoteMysqlIdentifier,
  quoteMysqlQualifiedIdentifier,
  quoteMysqlTable,
} from "./mysql-identifiers";
import { MysqlQueryCompilerOptions } from "./types";

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
}

export class MysqlRelationQueryBuilder {
  private readonly metadata = getOptionalEntityMetadata(this.options.entity);
  private readonly joins = new Map<string, RelationJoin>();
  private nextAlias = 1;

  readonly baseAlias = quoteMysqlIdentifier("npa_0");

  constructor(private readonly options: MysqlQueryCompilerOptions) {}

  prepare(query: ParsedQueryMethod): void {
    for (const part of query.predicate) {
      this.prepareProperty(part.condition.property);
    }

    for (const order of query.orderBy) {
      this.prepareProperty(order.property);
    }
  }

  hasJoins(): boolean {
    return this.joins.size > 0;
  }

  selectTarget(): string {
    return this.hasJoins() ? `${this.baseAlias}.*` : "*";
  }

  countDistinctTarget(): string {
    const primaryKey = mysqlPropertyToColumn(mysqlPrimaryKeyProperty(this.options), this.options);
    return this.hasJoins() ? `${this.baseAlias}.${primaryKey}` : primaryKey;
  }

  selectFrom(): string {
    if (!this.hasJoins()) {
      return quoteMysqlTable(this.options);
    }

    return `${quoteMysqlTable(this.options)} AS ${this.baseAlias}${this.selectJoinSql()}`;
  }

  deleteTarget(): string {
    if (!this.hasJoins()) {
      return "";
    }

    return `${this.baseAlias} `;
  }

  column(property: string): string {
    const relationPath = this.resolveRelationFieldPath(property);

    if (relationPath) {
      const join = this.ensureJoinPath(relationPath);
      return `${join.targetAlias}.${mysqlPropertyToColumn(relationPath.targetProperty, {
        entity: relationPath.targetMetadata.target,
      })}`;
    }

    const column = mysqlPropertyToColumn(property, this.options);
    return this.hasJoins() ? `${this.baseAlias}.${column}` : column;
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

        throw new Error(
          `Relation query ${this.metadata.target.name}.${property} targets ${currentMetadata.target.name}.${lowerFirst(remaining)}, but that property is not a column.`,
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
          (relation) => relation.kind === RelationKind.MANY_TO_ONE && relation.propertyName === property,
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

    if (relation.kind === RelationKind.MANY_TO_ONE) {
      const targetPrimary = requirePrimaryColumn(targetMetadata);
      const sourceJoinColumn = relationJoinColumnName(relation);
      const joinPredicate = `${qualifiedColumn(sourceAlias, sourceJoinColumn)} = ${qualifiedColumn(targetAlias, targetPrimary.columnName)}`;

      return {
        key,
        relation,
        targetMetadata,
        targetAlias,
        selectJoins: [` JOIN ${targetTable} AS ${targetAlias} ON ${joinPredicate}`],
      };
    }

    if (relation.kind === RelationKind.ONE_TO_MANY) {
      const sourcePrimary = requirePrimaryColumn(sourceMetadata);
      const targetRelation = findMappedManyToOne(sourceMetadata, targetMetadata, relation);
      const targetJoinColumn = relationJoinColumnName(targetRelation);
      const joinPredicate = `${qualifiedColumn(targetAlias, targetJoinColumn)} = ${qualifiedColumn(sourceAlias, sourcePrimary.columnName)}`;

      return {
        key,
        relation,
        targetMetadata,
        targetAlias,
        selectJoins: [` JOIN ${targetTable} AS ${targetAlias} ON ${joinPredicate}`],
      };
    }

    const sourcePrimary = requirePrimaryColumn(sourceMetadata);
    const targetPrimary = requirePrimaryColumn(targetMetadata);
    const joinAlias = this.nextQuotedAlias();
    const joinTable = qualifiedJoinTable(sourceMetadata, targetMetadata, relation);
    const sourceJoinColumn = joinTableColumnName(sourceMetadata);
    const targetJoinColumn = joinTableColumnName(targetMetadata);
    const sourcePredicate = `${qualifiedColumn(joinAlias, sourceJoinColumn)} = ${qualifiedColumn(sourceAlias, sourcePrimary.columnName)}`;
    const targetPredicate = `${qualifiedColumn(targetAlias, targetPrimary.columnName)} = ${qualifiedColumn(joinAlias, targetJoinColumn)}`;

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
    };
  }

  private selectJoinSql(): string {
    return [...this.joins.values()].flatMap((join) => join.selectJoins).join("");
  }

  private nextQuotedAlias(): string {
    const alias = quoteMysqlIdentifier(`npa_${this.nextAlias}`);
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
  return `${alias}.${quoteMysqlIdentifier(columnName)}`;
}

function qualifiedTable(metadata: EntityMetadata): string {
  const table = quoteMysqlQualifiedIdentifier(metadata.tableName);
  return metadata.schema ? `${quoteMysqlQualifiedIdentifier(metadata.schema)}.${table}` : table;
}

function qualifiedJoinTable(
  source: EntityMetadata,
  target: EntityMetadata,
  relation: RelationMetadata,
): string {
  const rawName = relation.joinTable ?? defaultJoinTableName(source, target);
  const separatorIndex = rawName.indexOf(".");

  if (separatorIndex > 0) {
    return `${quoteMysqlQualifiedIdentifier(rawName.slice(0, separatorIndex))}.${quoteMysqlQualifiedIdentifier(rawName.slice(separatorIndex + 1))}`;
  }

  const table = quoteMysqlQualifiedIdentifier(rawName);
  const schema = source.schema ?? target.schema;
  return schema ? `${quoteMysqlQualifiedIdentifier(schema)}.${table}` : table;
}

function requirePrimaryColumn(metadata: EntityMetadata) {
  if (!metadata.primaryColumn) {
    throw new Error(`Entity ${metadata.target.name} requires an @Id column.`);
  }

  return metadata.primaryColumn;
}

function findMappedManyToOne(
  sourceMetadata: EntityMetadata,
  targetMetadata: EntityMetadata,
  relation: RelationMetadata,
): RelationMetadata {
  if (!relation.mappedBy) {
    throw new Error(`@OneToMany ${sourceMetadata.target.name}.${relation.propertyName} requires mappedBy.`);
  }

  const targetRelation = targetMetadata.relations.find(
    (candidate) => candidate.kind === RelationKind.MANY_TO_ONE && candidate.propertyName === relation.mappedBy,
  );

  if (!targetRelation) {
    throw new Error(`@OneToMany ${sourceMetadata.target.name}.${relation.propertyName} mappedBy relation was not found.`);
  }

  return targetRelation;
}
