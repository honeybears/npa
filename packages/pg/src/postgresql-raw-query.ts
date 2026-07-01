import { PostgresqlCompiledQuery } from "./types";

export function compilePostgresqlRawQuery(
  text: string,
  values: unknown[],
  methodName: string,
): PostgresqlCompiledQuery {
  const named = replaceNamedPlaceholders(
    text,
    values,
    methodName,
    (position) => `$${position}`,
  );

  if (named) {
    return { text: named.text, values: named.values };
  }

  if (/\$\d+/.test(text) || values.length === 0) {
    return { text, values };
  }

  const converted = replaceQuestionMarkPlaceholders(text);

  if (converted.count !== values.length) {
    throw new Error(
      `@Query method "${methodName}" has ${converted.count} placeholder(s), received ${values.length} parameter(s).`,
    );
  }

  return { text: converted.text, values };
}

function replaceQuestionMarkPlaceholders(
  text: string,
): { text: string; count: number } {
  let result = "";
  let count = 0;
  let quote: string | undefined;

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

    if (character === "?") {
      count += 1;
      result += `$${count}`;
      continue;
    }

    result += character;
  }

  return { text: result, count };
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
  renderPlaceholder: (position: number) => string,
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

    if (character === ":" && text[index + 1] === ":") {
      result += "::";
      index += 1;
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
      namedValues[position] = values[position];
    }

    result += renderPlaceholder(position + 1);
    index += name.length;
  }

  if (names.length === 0) {
    return undefined;
  }

  if (values.length !== names.length) {
    throw new Error(
      `@Query method "${methodName}" uses named parameter(s) ${names.map((name) => `:${name}`).join(", ")}, received ${values.length} parameter(s).`,
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
