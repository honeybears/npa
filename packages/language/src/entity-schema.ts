import {
  NPALanguageEntityPropertyKind,
  NPALanguageEntityRelationKind,
  type NPALanguageEntityProperty,
  type NPALanguageEntitySchema,
  type NPALanguageWorkspaceSchema,
} from "./types";

export interface ResolvedNPAQueryProperty {
  property: NPALanguageEntityProperty;
  methodProperty: string;
  path: string[];
  missingRelationTarget?: string;
}

export function getDirectQueryProperties(
  entity: NPALanguageEntitySchema,
): NPALanguageEntityProperty[] {
  return entity.properties.filter((property) =>
    property.kind !== NPALanguageEntityPropertyKind.RELATION,
  );
}

export function getRelationProperties(
  entity: NPALanguageEntitySchema,
): NPALanguageEntityProperty[] {
  return entity.properties.filter((property) =>
    property.kind === NPALanguageEntityPropertyKind.RELATION,
  );
}

export function isManyToOneRelationProperty(
  property: NPALanguageEntityProperty,
): boolean {
  return property.kind === NPALanguageEntityPropertyKind.RELATION &&
    (property.relationKind === undefined ||
      property.relationKind === NPALanguageEntityRelationKind.MANY_TO_ONE);
}

export function findEntitySchema(
  workspace: NPALanguageWorkspaceSchema | undefined,
  className: string | undefined,
): NPALanguageEntitySchema | undefined {
  if (!workspace || !className) {
    return undefined;
  }

  return workspace.entities.find((entity) => entity.className === className);
}

export function resolveQueryProperty(
  entity: NPALanguageEntitySchema,
  methodProperty: string,
  workspace?: NPALanguageWorkspaceSchema,
): ResolvedNPAQueryProperty | undefined {
  const direct = getDirectQueryProperties(entity).find((property) =>
    property.name === methodProperty,
  );

  if (direct) {
    return {
      property: direct,
      methodProperty,
      path: [direct.name],
    };
  }

  for (const relation of getRelationProperties(entity)) {
    if (methodProperty === relation.name) {
      if (isManyToOneRelationProperty(relation)) {
        return {
          property: relation,
          methodProperty,
          path: [relation.name],
        };
      }

      continue;
    }

    if (!methodProperty.startsWith(relation.name)) {
      continue;
    }

    const targetPropertyName = decapitalize(
      methodProperty.slice(relation.name.length),
    );

    if (!targetPropertyName) {
      continue;
    }

    const target = findEntitySchema(workspace, relation.target);

    if (!target) {
      return {
        property: relation,
        methodProperty,
        path: [relation.name, targetPropertyName],
        missingRelationTarget: relation.target,
      };
    }

    const targetProperty = getDirectQueryProperties(target).find((property) =>
      property.name === targetPropertyName,
    );

    if (targetProperty) {
      return {
        property: targetProperty,
        methodProperty,
        path: [relation.name, targetProperty.name],
      };
    }
  }

  return undefined;
}

export function toMethodSegment(propertyName: string): string {
  return propertyName.charAt(0).toUpperCase() + propertyName.slice(1);
}

function decapitalize(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
