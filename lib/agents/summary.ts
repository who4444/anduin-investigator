import type { Event } from "../types";

const DEFAULT_PREVIEW = 400;

export interface CompactEvent {
  id: string;
  source: string;
  ts: string;
  actor: string;
  channel: string;
  text: string;
}

export function compactEvent(event: Event, limit = DEFAULT_PREVIEW): CompactEvent {
  return {
    id: event.id,
    source: event.source,
    ts: event.ts,
    actor: event.actorResolved ?? event.actor,
    channel: event.channel,
    text: event.text.slice(0, limit),
  };
}

export function summarizeEvents(events: Event[]): string {
  if (events.length === 0) return "The event store is empty.";

  const bySource = new Map<string, number>();
  const byActor = new Map<string, number>();
  for (const event of events) {
    bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);
    const actor = event.actorResolved ?? event.actor;
    byActor.set(actor, (byActor.get(actor) ?? 0) + 1);
  }

  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const sources = [...bySource.entries()].map(([source, count]) => `${source} (${count})`).join(", ");
  const actors = [...byActor.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 12)
    .map(([actor, count]) => `${actor} (${count})`)
    .join(", ");

  return [
    `Total events: ${events.length}`,
    `Sources: ${sources}`,
    `Time range: ${sorted[0].ts} to ${sorted[sorted.length - 1].ts}`,
    `Actors (most active first): ${actors}`,
  ].join("\n");
}

export function sampleEvents(events: Event[], count: number): CompactEvent[] {
  if (events.length === 0) return [];
  if (count <= 0) return [];
  if (count === 1) return [compactEvent(events[0])];
  if (events.length <= count) return events.map((event) => compactEvent(event));

  const step = (events.length - 1) / (count - 1);
  const picked: CompactEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(compactEvent(events[Math.round(index * step)]));
  }
  return picked;
}
