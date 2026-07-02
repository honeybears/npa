import {
  registerColumn,
  registerCreatedAt,
  registerEntity,
  registerId,
  registerIndex,
  registerRelation,
  registerUpdatedAt,
  registerVersion,
} from "./metadata-storage";
import {
  ColumnOptions,
  EntityOptions,
  EntityTarget,
  IndexOptions,
  RelationKind,
  RelationOptions,
} from "./types";

export function Entity(options: EntityOptions | string = {}): ClassDecorator {
  const resolvedOptions = typeof options === "string" ? { name: options } : options;

  return (target) => {
    registerEntity(target as unknown as EntityTarget, resolvedOptions);
  };
}

export function Id(options: ColumnOptions | string = {}): PropertyDecorator {
  const resolvedOptions = normalizeColumnOptions(options);

  return (target, propertyKey) => {
    registerId(target, propertyKey, resolvedOptions);
  };
}

export function Column(options: ColumnOptions | string = {}): PropertyDecorator {
  const resolvedOptions = normalizeColumnOptions(options);

  return (target, propertyKey) => {
    registerColumn(target, propertyKey, resolvedOptions);
  };
}

export function CreatedAt(options: ColumnOptions | string = {}): PropertyDecorator {
  const resolvedOptions = normalizeColumnOptions(options);

  return (target, propertyKey) => {
    registerCreatedAt(target, propertyKey, resolvedOptions);
  };
}

export function UpdatedAt(options: ColumnOptions | string = {}): PropertyDecorator {
  const resolvedOptions = normalizeColumnOptions(options);

  return (target, propertyKey) => {
    registerUpdatedAt(target, propertyKey, resolvedOptions);
  };
}

export function Version(options: ColumnOptions | string = {}): PropertyDecorator {
  const resolvedOptions = normalizeColumnOptions(options);

  return (target, propertyKey) => {
    registerVersion(target, propertyKey, resolvedOptions);
  };
}

export function Index(options: IndexOptions | IndexOptions[]): ClassDecorator {
  const resolvedOptions = Array.isArray(options) ? options : [options];

  return ((target: object | EntityTarget, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      throw new Error("@Index can only be used on entity classes. Use @Column({ index: true }) or @Column({ unique: true }) for single-column indexes.");
    }

    for (const option of resolvedOptions) {
      registerIndex(target as EntityTarget, option);
    }
  }) as ClassDecorator;
}

export function OneToMany(
  target: () => EntityTarget,
  options: RelationOptions = {},
): PropertyDecorator {
  return (source, propertyKey) => {
    registerRelation(source, propertyKey, RelationKind.ONE_TO_MANY, target, options);
  };
}

export function ManyToOne(
  target: () => EntityTarget,
  options: RelationOptions = {},
): PropertyDecorator {
  return (source, propertyKey) => {
    registerRelation(source, propertyKey, RelationKind.MANY_TO_ONE, target, options);
  };
}

export function ManyToMany(
  target: () => EntityTarget,
  options: RelationOptions = {},
): PropertyDecorator {
  return (source, propertyKey) => {
    registerRelation(source, propertyKey, RelationKind.MANY_TO_MANY, target, options);
  };
}

function normalizeColumnOptions(
  options: ColumnOptions | string,
): ColumnOptions {
  return typeof options === "string" ? { name: options } : options;
}
