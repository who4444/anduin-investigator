import { extractJson, isPlainObject } from "../json";
import type { LlmClient } from "../llm";
import type { Event, InvestigationScope } from "../types";

/* The escalation names a client and a project; the store may hold records for
   many clients and projects. The model proposes which identifiers belong to
   this escalation; the code below keeps only identifiers that actually exist
   in the registry, so scoping never rests on invented names. */

export interface ScopeUniverse {
  ticketPrefixes: string[];
  channels: string[];
  senderDomains: string[];
}

export interface ReportScope extends InvestigationScope {
  excludedRecords: number;
}

const EMAIL_DOMAIN = /@([A-Za-z0-9.-]+)/;
const TICKET_KEY = /^([A-Za-z][A-Za-z0-9]+)-\d+/;

export function deriveScopeUniverse(events: Event[]): ScopeUniverse {
  const prefixes = new Set<string>();
  const channels = new Set<string>();
  const domains = new Set<string>();
  for (const event of events) {
    if (event.source === "jira") {
      const match = event.channel.match(TICKET_KEY);
      if (match) prefixes.add(match[1].toUpperCase());
    } else if (event.source === "slack") {
      if (event.channel && event.channel !== "slack") channels.add(event.channel.toLowerCase());
    } else if (event.source === "email") {
      const match = event.actor.match(EMAIL_DOMAIN);
      if (match) domains.add(match[1].toLowerCase());
    }
  }
  return {
    ticketPrefixes: [...prefixes].sort(),
    channels: [...channels].sort(),
    senderDomains: [...domains].sort(),
  };
}

export function matchScope(scope: InvestigationScope | null, event: Event): boolean {
  if (!scope) return true;
  if (event.source === "jira") {
    return scope.ticketPrefixes.some((prefix) =>
      event.channel.toUpperCase().startsWith(`${prefix.toUpperCase()}-`),
    );
  }
  if (event.source === "slack") {
    return scope.channels.includes(event.channel.toLowerCase());
  }
  const domain = event.actor.match(EMAIL_DOMAIN)?.[1]?.toLowerCase();
  if (domain && scope.senderDomains.includes(domain)) return true;
  return scope.ticketPrefixes.some(
    (prefix) =>
      new RegExp(`\\b${prefix}-\\d+`, "i").test(event.text) ||
      (event.refs ?? []).some((ref) => ref.toUpperCase().startsWith(`${prefix.toUpperCase()}-`)),
  );
}

export function splitEventsByScope(
  events: Event[],
  scope: InvestigationScope | null,
): { inScope: Event[]; outOfScope: Event[] } {
  if (!scope) return { inScope: events, outOfScope: [] };

  // An email thread is one unit: a reply that cites no ticket of its own still
  // belongs to the escalation when its thread root does.
  const scopedThreads = new Set<string>();
  for (const event of events) {
    if (event.source === "email" && event.threadId && matchScope(scope, event)) {
      scopedThreads.add(event.threadId);
    }
  }

  const inScope: Event[] = [];
  const outOfScope: Event[] = [];
  for (const event of events) {
    const inThread =
      event.source === "email" && event.threadId !== undefined && scopedThreads.has(event.threadId);
    (matchScope(scope, event) || inThread ? inScope : outOfScope).push(event);
  }
  return { inScope, outOfScope };
}

export function scopePromptLine(scope: InvestigationScope | null): string | null {
  if (!scope) return null;
  const who = scope.client ?? "an unnamed client";
  const what = scope.project ?? "the escalation's project";
  return `Scope: this escalation is from ${who} about ${what}. The evidence registry may contain records for other clients and projects; only findings about this client and project belong in this investigation, and the source tools already hide out-of-scope records.`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function nameOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function identifyScope(
  escalation: string,
  events: Event[],
  client: LlmClient,
): Promise<InvestigationScope | null> {
  const universe = deriveScopeUniverse(events);
  const empty =
    universe.ticketPrefixes.length === 0 &&
    universe.channels.length === 0 &&
    universe.senderDomains.length === 0;
  if (empty) return null;

  const user = [
    "Escalation message:",
    escalation.trim() || "(no escalation text was provided)",
    "",
    "Identifiers that actually exist in the evidence registry (JSON):",
    JSON.stringify(universe),
    "",
    'Identify which client and project this escalation concerns. Reply with JSON only:',
    '{"client":"client name or null","project":"project or product name or null","ticketPrefixes":[],"channels":[],"senderDomains":[]}',
    "Only propose identifiers from the list above. Ignore any other client or project that appears in the registry.",
  ].join("\n");

  let content: string;
  try {
    const response = await client.chat(
      [
        {
          role: "system",
          content:
            "You identify which client and project a client-escalation investigation concerns. Be conservative: propose only identifiers the escalation actually points at.",
        },
        { role: "user", content: user },
      ],
      { forceJson: true },
    );
    content = response.content;
  } catch {
    return null;
  }

  const parsed = extractJson(content);
  if (!isPlainObject(parsed)) return null;

  const inUniverse = (proposed: string[], universeList: string[]): string[] =>
    proposed.filter((entry) => universeList.includes(entry));

  const ticketPrefixes = stringList(parsed.ticketPrefixes)
    .filter((entry) => universe.ticketPrefixes.includes(entry.toUpperCase()))
    .map((entry) => entry.toUpperCase());
  const channels = inUniverse(stringList(parsed.channels), universe.channels);
  const senderDomains = inUniverse(stringList(parsed.senderDomains), universe.senderDomains);

  if (ticketPrefixes.length === 0 && channels.length === 0 && senderDomains.length === 0) {
    return null;
  }

  return {
    client: nameOf(parsed.client),
    project: nameOf(parsed.project),
    ticketPrefixes,
    channels,
    senderDomains,
  };
}
