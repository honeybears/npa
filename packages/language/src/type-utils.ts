export function normalizeType(type: string | undefined): string {
  const normalized = (type ?? "")
    .replace(/\[\]/g, "")
    .replace(/\?/g, "")
    .toLowerCase();

  if (normalized.includes("string")) {
    return "string";
  }

  if (normalized.includes("number")) {
    return "number";
  }

  if (normalized.includes("bigint") || normalized.includes("biginteger")) {
    return "bigint";
  }

  if (normalized.includes("boolean")) {
    return "boolean";
  }

  if (normalized.includes("date")) {
    return "date";
  }

  return "unknown";
}
