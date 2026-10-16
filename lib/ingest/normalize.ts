import { createHash } from "node:crypto";

import type { EventInput, SourceKind } from "../types";

export function eventId(
  source: SourceKind,
  ts: string,
  actor: string,
  channel: string,
  text: string,
): string {
  const digest = createHash("sha1")
    .update(`${source}|${ts}|${actor}|${channel}|${text}`)
    .digest("hex");
  return `e_${digest.slice(0, 16)}`;
}

export function isoFromEpoch(sec: number | string): string {
  const seconds = typeof sec === "number" ? sec : Number(sec.trim());
  return new Date(Math.round(seconds * 1000)).toISOString();
}

/* Zone evidence a timestamp must carry to be parsed: an explicit offset
   (Z / ±HH:MM / ±HHMM) or a named zone. Offset-less strings are rejected
   rather than interpreted in the host's timezone. */
const NAMED_ZONE = /(?:\s|^)(?:UTC|GMT|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\s*$/i;
const NUMERIC_OFFSET = /[+-]\d{2}:?\d{2}$/;

export function toUtcIso(ts: string): string {
  const input = ts.trim();
  if (!input) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split("-").map(Number);
    const utc = Date.UTC(year, month - 1, day);
    const check = new Date(utc);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return "";
    }
    return check.toISOString();
  }

  const hasZone = input.endsWith("Z") || input.endsWith("z") || NUMERIC_OFFSET.test(input) || NAMED_ZONE.test(input);
  if (!hasZone) return "";
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

const TRUNCATION_MARKER = "…[truncated]";

export function capText(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + TRUNCATION_MARKER;
}

export function dedupeEvents(events: EventInput[]): EventInput[] {
  const seen = new Set<string>();
  const out: EventInput[] = [];
  for (const event of events) {
    const key = JSON.stringify([
      event.source,
      event.ts,
      event.actor,
      event.channel,
      event.text,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}
