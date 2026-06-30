import {
  registerColumn,
  registerEntity,
  registerId,
  registerIndex,
  registerRelation,
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

export function Version(options: ColumnOptions | string = {}): PropertyDecorator {
  const resolvedOptions = normalizeColumnOptions(options);

  return (target, propertyKey) => {
    registerVersion(target, propertyKey, resolvedOptions);
  };
}

export function Index(options: IndexOptions | string = {}): ClassDecorator & PropertyDecorator {
  return createIndexDecorator(normalizeIndexOptions(options), false);
}

export function Unique(options: IndexOptions | string = {}): ClassDecorator & PropertyDecorator {
  return createIndexDecorator(normalizeIndexOptions(options), true);
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

function normalizeIndexOptions(options: IndexOptions | string): IndexOptions {
  return typeof options === "string" ? { name: options } : options;
}

function createIndexDecorator(
  options: IndexOptions,
  unique: boolean,
): ClassDecorator & PropertyDecorator {
  return ((target: object | EntityTarget, propertyKey?: string | symbol) => {
    registerIndex(target as object | EntityTarget, propertyKey, options, unique);
  }) as ClassDecorator & PropertyDecorator;
}
