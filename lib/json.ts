function tryParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function extractJson(content: string): unknown {
  const direct = tryParse(content);
  if (direct !== undefined) return direct;

  const objectStart = content.indexOf("{");
  const arrayStart = content.indexOf("[");
  const from =
    objectStart === -1 ? arrayStart : arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart);
  if (from === -1) return undefined;

  const end = Math.max(content.lastIndexOf("}"), content.lastIndexOf("]"));
  if (end <= from) return undefined;

  return tryParse(content.slice(from, end + 1));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
