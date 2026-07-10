import { compileRawQuery } from "@node-persistence-api/core/adapter";
import { PostgresqlCompiledQuery } from "./types";

export function compilePostgresqlRawQuery(
  text: string,
  values: unknown[],
  methodName: string,
): PostgresqlCompiledQuery {
  return compileRawQuery(text, values, methodName, {
    keepNativePositionalPlaceholders: true,
    renderPlaceholder: (position) => `$${position}`,
  });
}
