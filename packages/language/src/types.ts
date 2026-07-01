import type {
  ParsedQueryMethod,
  QueryMethodAction,
} from "@honeybeaers/npa/query-method";

export enum NPALanguageEntityPropertyKind {
  ID = "ID",
  COLUMN = "COLUMN",
  RELATION = "RELATION",
}

export enum NPAQueryMethodCompletionKind {
  METHOD = "METHOD",
}

export enum NPAQueryMethodDiagnosticSeverity {
  ERROR = "ERROR",
  WARNING = "WARNING",
}

export enum NPAQueryMethodDiagnosticCode {
  INVALID_METHOD_NAME = "INVALID_METHOD_NAME",
  UNKNOWN_PROPERTY = "UNKNOWN_PROPERTY",
  UNKNOWN_RELATION_TARGET = "UNKNOWN_RELATION_TARGET",
  UNSUPPORTED_OPERATOR = "UNSUPPORTED_OPERATOR",
  UNSUPPORTED_ORDER_PROPERTY = "UNSUPPORTED_ORDER_PROPERTY",
}

export interface NPALanguageEntityProperty {
  name: string;
  kind: NPALanguageEntityPropertyKind;
  type?: string;
  target?: string;
  nullable?: boolean;
}

export interface NPALanguageEntitySchema {
  className: string;
  properties: NPALanguageEntityProperty[];
}

export interface NPALanguageWorkspaceSchema {
  entities: NPALanguageEntitySchema[];
}

export interface NPAQueryMethodCompletion {
  kind: NPAQueryMethodCompletionKind;
  name: string;
  insertText: string;
  detail: string;
  sortText?: string;
}

export interface GetNPAQueryMethodCompletionsOptions {
  prefix: string;
  entity: NPALanguageEntitySchema;
  workspace?: NPALanguageWorkspaceSchema;
  actions?: QueryMethodAction[];
  includeOrderBy?: boolean;
  limit?: number;
}

export interface ValidateNPAQueryMethodOptions {
  methodName: string;
  entity: NPALanguageEntitySchema;
  workspace?: NPALanguageWorkspaceSchema;
}

export interface NPAQueryMethodDiagnostic {
  code: NPAQueryMethodDiagnosticCode;
  severity: NPAQueryMethodDiagnosticSeverity;
  message: string;
  property?: string;
}

export interface NPAQueryMethodValidationResult {
  parsed?: ParsedQueryMethod;
  diagnostics: NPAQueryMethodDiagnostic[];
}
