import { NPAQueryError } from "@node-persistence-api/core";
import { MysqlCompiledQuery } from "./types";

export function compileMysqlRawQuery(
  text: string,
  values: unknown[],
  methodName: string,
): MysqlCompiledQuery {
  const named = replaceNamedPlaceholders(text, values, methodName);

  if (named) {
    return { text: named.text, values: named.values };
  }

  const placeholderCount = countQuestionMarkPlaceholders(text);

  if (placeholderCount !== values.length) {
    throw new NPAQueryError(
      `@Query method "${methodName}" has ${placeholderCount} placeholder(s), received ${values.length} parameter(s).`,
      {
        code: "NPA_RAW_QUERY_PLACEHOLDER_MISMATCH",
        details: { methodName, expected: placeholderCount, received: values.length },
      },
    );
  }

  return { text, values };
}

function countQuestionMarkPlaceholders(text: string): number {
  let count = 0;
  let quote: string | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quote) {
      if (character === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          index += 1;
        } else {
          quote = undefined;
        }
      }

      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }

    if (character === "?") {
      count += 1;
    }
  }

  return count;
}

interface NamedPlaceholderResult {
  text: string;
  names: string[];
  values: unknown[];
}

function replaceNamedPlaceholders(
  text: string,
  values: unknown[],
  methodName: string,
): NamedPlaceholderResult | undefined {
  let result = "";
  let quote: string | undefined;
  const names: string[] = [];
  const positions = new Map<string, number>();
  const namedValues: unknown[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quote) {
      result += character;

      if (character === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          result += text[index + 1];
          index += 1;
        } else {
          quote = undefined;
        }
      }

      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += character;
      continue;
    }

    if (character !== ":") {
      result += character;
      continue;
    }

    const name = readPlaceholderName(text, index + 1);

    if (!name) {
      result += character;
      continue;
    }

    let position = positions.get(name);

    if (position === undefined) {
      position = positions.size;
      positions.set(name, position);
      names.push(name);
    }

    namedValues.push(values[position]);
    result += "?";
    index += name.length;
  }

  if (names.length === 0) {
    return undefined;
  }

  if (values.length !== names.length) {
    throw new NPAQueryError(
      `@Query method "${methodName}" uses named parameter(s) ${names.map((name) => `:${name}`).join(", ")}, received ${values.length} parameter(s).`,
      {
        code: "NPA_RAW_QUERY_PLACEHOLDER_MISMATCH",
        details: { methodName, expected: names.length, received: values.length },
      },
    );
  }

  return { text: result, names, values: namedValues };
}

function readPlaceholderName(text: string, start: number): string | undefined {
  const first = text[start];

  if (!first || !/[A-Za-z_]/.test(first)) {
    return undefined;
  }

  let end = start + 1;

  while (/[A-Za-z0-9_]/.test(text[end] ?? "")) {
    end += 1;
  }

  return text.slice(start, end);
}
