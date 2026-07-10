import { compileRawQuery } from "@node-persistence-api/core/adapter";
import { MysqlCompiledQuery } from "./types";

export function compileMysqlRawQuery(
  text: string,
  values: unknown[],
  methodName: string,
): MysqlCompiledQuery {
  return compileRawQuery(text, values, methodName, {
    renderPlaceholder: () => "?",
    repeatNamedValues: true,
  });
}
