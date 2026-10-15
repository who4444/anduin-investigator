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
