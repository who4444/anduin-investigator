import { unzipSync } from "fflate";

export type FileKind =
  | "jira"
  | "email-mbox"
  | "email-eml"
  | "slack-users"
  | "slack-channels"
  | "slack-messages"
  | "zip"
  | "unknown";

export interface IngestFile {
  name: string;
  bytes: Uint8Array;
}

export interface DetectedFile {
  kind: FileKind;
  json?: unknown;
}

const MAX_ZIP_DEPTH = 2;
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

export interface ExpandOptions {
  warnings?: string[];
  depth?: number;
  maxDecompressedBytes?: number;
}

function basename(name: string): string {
  const parts = name.split(/[\\/]/).filter((part) => part && part !== ".");
  return parts[parts.length - 1] ?? name;
}

function extension(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeJiraIssue(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.key === "string" &&
    isObject(value.fields)
  ) || (
    isObject(value) &&
    typeof value.id === "string" &&
    isObject(value.fields) &&
    typeof value.fields.summary === "string"
  );
}

function looksLikeUsers(value: unknown): boolean {
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, entry]) =>
      /^[A-Z][A-Z0-9]{1,}$/.test(key) &&
      isObject(entry) &&
      ("real_name" in entry || "profile" in entry || "name" in entry || "display_name" in entry),
  );
}

function looksLikeChannels(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (entry) =>
      isObject(entry) &&
      typeof entry.id === "string" &&
      typeof entry.name === "string" &&
      !("ts" in entry),
  );
}

function looksLikeSlackMessages(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some(
    (entry) =>
      isObject(entry) &&
      (typeof entry.ts === "string" || typeof entry.ts === "number") &&
      ("user" in entry || "text" in entry || "subtype" in entry || "bot_id" in entry),
  );
}

function parseJson(bytes: Uint8Array): { ok: boolean; json?: unknown } {
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function detectFile(file: IngestFile): DetectedFile {
  const ext = extension(file.name);

  if (ext === "mbox") return { kind: "email-mbox" };
  if (ext === "eml") return { kind: "email-eml" };
  if (ext === "zip") return { kind: "zip" };

  if (ext === "json") {
    const { ok, json } = parseJson(file.bytes);
    if (!ok) return { kind: "unknown" };

    if (isObject(json) && Array.isArray(json.issues)) return { kind: "jira", json };
    if (looksLikeJiraIssue(json)) return { kind: "jira", json };

    const base = basename(file.name).toLowerCase();
    if (looksLikeSlackMessages(json)) return { kind: "slack-messages", json };
    if (base === "channels.json" || looksLikeChannels(json)) return { kind: "slack-channels", json };
    if (base === "users.json" || looksLikeUsers(json)) return { kind: "slack-users", json };

    return { kind: "unknown" };
  }

  return { kind: "unknown" };
}

export function expandArchives(files: IngestFile[], options: ExpandOptions = {}): IngestFile[] {
  const {
    warnings = [],
    depth = 0,
    maxDecompressedBytes = MAX_DECOMPRESSED_BYTES,
  } = options;
  if (depth >= MAX_ZIP_DEPTH) return files;

  const out: IngestFile[] = [];
  for (const file of files) {
    if (extension(file.name) !== "zip") {
      out.push(file);
      continue;
    }

    let entries: Record<string, Uint8Array>;
    try {
      let oversized = false;
      let totalBytes = 0;
      entries = unzipSync(file.bytes, {
        filter: (member) => {
          totalBytes += member.originalSize;
          if (totalBytes > maxDecompressedBytes) {
            oversized = true;
            return false;
          }
          return true;
        },
      });
      if (oversized) {
        warnings.push(
          `Archive ${file.name} expands beyond ${maxDecompressedBytes} bytes; skipped.`,
        );
        continue;
      }
    } catch {
      warnings.push(`Unreadable archive: ${file.name}`);
      continue;
    }

    const members = Object.entries(entries).filter(([name]) => !name.endsWith("/"));
    const inflatedBytes = members.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
    if (inflatedBytes > maxDecompressedBytes) {
      warnings.push(`Archive ${file.name} expands to ${inflatedBytes} bytes; skipped.`);
      continue;
    }

    const inner: IngestFile[] = members.map(([name, bytes]) => ({ name, bytes }));
    out.push(...expandArchives(inner, { warnings, depth: depth + 1, maxDecompressedBytes }));
  }
  return out;
}
