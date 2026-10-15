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
  const raw = typeof sec === "number" ? sec.toString() : sec.trim();
  const dot = raw.indexOf(".");
  const wholePart = dot === -1 ? raw : raw.slice(0, dot);
  const fracPart = dot === -1 ? "" : raw.slice(dot + 1);
  const wholeMs = Number(wholePart) * 1000;
  const fracMs = fracPart.length > 0 ? Number(fracPart) : 0;
  return new Date(wholeMs + fracMs).toISOString();
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
