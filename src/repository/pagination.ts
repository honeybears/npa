import { NPAPaginationError } from "../error";

const PAGEABLE_MARKER = "__pageable";

export interface OffsetPageable {
  readonly __pageable: true;
  readonly kind: "offset";
  readonly page: number;
  readonly size: number;
}

export interface CursorPageable {
  readonly __pageable: true;
  readonly kind: "cursor";
  readonly after?: string;
  readonly before?: string;
  readonly size: number;
}

export type PageRequest = OffsetPageable | CursorPageable;

export interface Page<TEntity> {
  content: TEntity[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface CursorPage<TEntity> {
  content: TEntity[];
  size: number;
  nextCursor: string | null;
  previousCursor: string | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface CursorQueryOrder {
  property: string;
  direction: "asc" | "desc";
  expression: string;
  resultKey: string;
  hidden?: boolean;
}

export interface CursorQueryMetadata {
  pageable: CursorPageable;
  orders: CursorQueryOrder[];
  reverse: boolean;
}

export class Pageable {
  static offset(page: number, size: number): OffsetPageable {
    assertInteger(page, "page");
    assertInteger(size, "size");

    if (page < 0) {
      throw new NPAPaginationError("Offset page must be greater than or equal to 0.", {
        code: "NPA_INVALID_OFFSET_PAGE",
        details: { page },
      });
    }

    if (size <= 0) {
      throw new NPAPaginationError("Page size must be greater than 0.", {
        code: "NPA_INVALID_PAGE_SIZE",
        details: { size },
      });
    }

    return { [PAGEABLE_MARKER]: true, kind: "offset", page, size };
  }

  static cursor(options: {
    after?: string;
    before?: string;
    size: number;
  }): CursorPageable {
    assertInteger(options.size, "size");

    if (options.size <= 0) {
      throw new NPAPaginationError("Page size must be greater than 0.", {
        code: "NPA_INVALID_PAGE_SIZE",
        details: { size: options.size },
      });
    }

    if (options.after && options.before) {
      throw new NPAPaginationError("Cursor pagination cannot use both after and before.", {
        code: "NPA_CURSOR_DIRECTION_CONFLICT",
      });
    }

    return {
      [PAGEABLE_MARKER]: true,
      kind: "cursor",
      ...(options.after ? { after: options.after } : {}),
      ...(options.before ? { before: options.before } : {}),
      size: options.size,
    };
  }
}

export function isPageable(value: unknown): value is PageRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __pageable?: unknown })[PAGEABLE_MARKER] === true
  );
}

export function isOffsetPageable(
  value: PageRequest,
): value is OffsetPageable {
  return value.kind === "offset";
}

export function isCursorPageable(
  value: PageRequest,
): value is CursorPageable {
  return value.kind === "cursor";
}

export function createPage<TEntity>(
  content: TEntity[],
  pageable: OffsetPageable,
  totalElements: number,
): Page<TEntity> {
  const totalPages = Math.ceil(totalElements / pageable.size);

  return {
    content,
    page: pageable.page,
    size: pageable.size,
    totalElements,
    totalPages,
    hasNextPage: pageable.page + 1 < totalPages,
    hasPreviousPage: pageable.page > 0,
  };
}

export function createCursorWindow<TRow extends object>(
  rows: TRow[],
  metadata: CursorQueryMetadata,
): CursorPage<TRow> {
  const { pageable } = metadata;
  const hasExtra = rows.length > pageable.size;
  const pageRows = rows.slice(0, pageable.size);
  const content = metadata.reverse ? pageRows.reverse() : pageRows;
  const first = content[0];
  const last = content[content.length - 1];
  const hasPreviousPage = metadata.reverse ? hasExtra : Boolean(pageable.after);
  const hasNextPage = metadata.reverse ? Boolean(pageable.before) : hasExtra;

  return {
    content,
    size: pageable.size,
    nextCursor: last && hasNextPage ? encodeCursor(last, metadata) : null,
    previousCursor: first && hasPreviousPage
      ? encodeCursor(first, metadata)
      : null,
    hasNextPage,
    hasPreviousPage,
  };
}

export function stripCursorKeys<TEntity extends object>(
  rows: TEntity[],
  metadata: CursorQueryMetadata,
): TEntity[] {
  const hiddenKeys = metadata.orders
    .filter((order) => order.hidden)
    .map((order) => order.resultKey);

  if (hiddenKeys.length === 0) {
    return rows;
  }

  for (const row of rows) {
    for (const key of hiddenKeys) {
      delete (row as Record<string, unknown>)[key];
    }
  }

  return rows;
}

export function decodeCursorValues(cursor: string): unknown[] {
  try {
    const parsed = JSON.parse(base64UrlDecode(cursor)) as {
      v?: unknown;
      values?: unknown;
    };

    if (parsed.v !== 1 || !Array.isArray(parsed.values)) {
      throw new NPAPaginationError("Invalid cursor.", {
        code: "NPA_INVALID_CURSOR",
      });
    }

    return parsed.values.map(decodeCursorValue);
  } catch (error) {
    throw new NPAPaginationError("Invalid cursor.", {
      code: "NPA_INVALID_CURSOR",
      cause: error,
    });
  }
}

function encodeCursor<TRow extends object>(
  row: TRow,
  metadata: CursorQueryMetadata,
): string {
  const record = row as Record<string, unknown>;
  return base64UrlEncode(JSON.stringify({
    v: 1,
    values: metadata.orders.map((order) => encodeCursorValue(record[order.resultKey])),
  }));
}

function encodeCursorValue(value: unknown): unknown {
  if (value instanceof Date) {
    return { __cursorType: "Date", value: value.toISOString() };
  }

  return value;
}

function decodeCursorValue(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { __cursorType?: unknown }).__cursorType === "Date" &&
    typeof (value as { value?: unknown }).value === "string"
  ) {
    return new Date((value as { value: string }).value);
  }

  return value;
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new NPAPaginationError(`Pageable ${name} must be an integer.`, {
      code: name === "page" ? "NPA_INVALID_OFFSET_PAGE" : "NPA_INVALID_PAGE_SIZE",
      details: { [name]: value },
    });
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );

  return Buffer.from(padded, "base64").toString("utf8");
}
