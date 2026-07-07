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

  if (normalized.includes("boolean")) {
    return "boolean";
  }

  if (normalized.includes("date")) {
    return "Date";
  }

  return "unknown";
}
