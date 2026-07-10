import { NPAQueryError } from "../error";

export interface RawQueryPlaceholderOptions {
  keepNativePositionalPlaceholders?: boolean;
  renderPlaceholder(position: number): string;
  repeatNamedValues?: boolean;
}

export interface CompiledRawQuery {
  text: string;
  values: unknown[];
}

export function compileRawQuery(
  text: string,
  values: unknown[],
  methodName: string,
  options: RawQueryPlaceholderOptions,
): CompiledRawQuery {
  const named = replaceNamedPlaceholders(text, values, methodName, options);

  if (named) {
    return named;
  }

  if (
    values.length === 0 ||
    (options.keepNativePositionalPlaceholders && /\$\d+/.test(text))
  ) {
    return { text, values };
  }

  const positional = replaceQuestionMarkPlaceholders(text, options.renderPlaceholder);

  if (positional.count !== values.length) {
    throw placeholderMismatchError(methodName, positional.count, values.length);
  }

  return { text: positional.text, values };
}

function replaceQuestionMarkPlaceholders(
  text: string,
  renderPlaceholder: (position: number) => string,
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
      result += renderPlaceholder(count);
      continue;
    }

    result += character;
  }

  return { text: result, count };
}

function replaceNamedPlaceholders(
  text: string,
  values: unknown[],
  methodName: string,
  options: RawQueryPlaceholderOptions,
): CompiledRawQuery | undefined {
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
    }

    namedValues[options.repeatNamedValues ? namedValues.length : position] = values[position];
    result += options.renderPlaceholder(position + 1);
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

  return { text: result, values: namedValues };
}

function placeholderMismatchError(methodName: string, expected: number, received: number) {
  return new NPAQueryError(
    `@Query method "${methodName}" has ${expected} placeholder(s), received ${received} parameter(s).`,
    {
      code: "NPA_RAW_QUERY_PLACEHOLDER_MISMATCH",
      details: { methodName, expected, received },
    },
  );
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
