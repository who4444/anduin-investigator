import { extractJson, isPlainObject } from "../json";
import type { LlmClient } from "../llm";
import type { Event, InvestigationScope, ScopeAnchor, ScopeConfidence } from "../types";

/* The escalation names a client and a project; the store may hold records for
   many clients and projects. The model proposes which identifiers belong to
   this escalation; the code below keeps only identifiers that actually exist
   in the registry and grades how much independent evidence agrees, so scope
   never rests on an invented name or a single lucky string match. */

export interface ScopeUniverse {
  ticketPrefixes: string[];
  channels: string[];
  senderDomains: string[];
}

export interface ReportScope extends InvestigationScope {
  excludedRecords: number;
}

const EMAIL_DOMAIN = /@([A-Za-z0-9.-]+)/;
const EMAIL_ADDRESS = /[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g;
const TICKET_KEY = /^([A-Za-z][A-Za-z0-9]+)-\d+/;
const TICKET_ANYWHERE = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;

/* Three independent verified anchors are the bar for "scoped". */
const SCOPED_MIN_ANCHORS = 3;

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
  // An unconfirmed scope applies no filtering: every stored record is in play.
  if (!scope || scope.confidence === "none") return true;
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
  if (!scope || scope.confidence === "none") return { inScope: events, outOfScope: [] };

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
  if (!scope || scope.confidence === "none") return null;
  const who = scope.client ?? "an unnamed client";
  const what = scope.project ?? "the escalation's project";
  return `Scope: this escalation is from ${who} about ${what}. The evidence registry may contain records for other clients and projects; only findings about this client and project belong in this investigation, and the source tools already hide out-of-scope records.`;
}

function matchesAnchor(anchor: ScopeAnchor, event: Event): boolean {
  if (anchor.kind === "ticket-prefix") {
    const prefix = anchor.value.toUpperCase();
    return (
      event.channel.toUpperCase().startsWith(`${prefix}-`) ||
      new RegExp(`\\b${prefix}-\\d+`, "i").test(event.text) ||
      (event.refs ?? []).some((ref) => ref.toUpperCase().startsWith(`${prefix}-`))
    );
  }
  if (anchor.kind === "channel") {
    return event.channel.toLowerCase() === anchor.value.toLowerCase();
  }
  if (anchor.kind === "sender-domain") {
    const domain = event.actor.match(EMAIL_DOMAIN)?.[1]?.toLowerCase();
    return domain === anchor.value.toLowerCase();
  }
  return false;
}

function anchorKey(anchor: ScopeAnchor): string {
  return `${anchor.kind}|${anchor.value.toLowerCase()}`;
}

const SOURCE_PRECEDENCE: Record<ScopeAnchor["source"], number> = {
  declared: 3,
  escalation: 2,
  model: 1,
};

function dedupeAnchors(anchors: ScopeAnchor[]): ScopeAnchor[] {
  const byKey = new Map<string, ScopeAnchor>();
  for (const anchor of anchors) {
    const key = anchorKey(anchor);
    const existing = byKey.get(key);
    if (!existing || SOURCE_PRECEDENCE[anchor.source] > SOURCE_PRECEDENCE[existing.source]) {
      byKey.set(key, anchor);
    }
  }
  return [...byKey.values()];
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((token) => token.length > 2));
}

function findEscalationEmail(escalation: string, events: Event[]): Event | null {
  const needle = normalizeForMatch(escalation);
  const needleTokens = tokensOf(needle);
  if (needleTokens.size < 6) return null;
  const probe = needle.slice(0, 80);

  let best: { event: Event; score: number } | null = null;
  for (const event of events) {
    if (event.source !== "email") continue;
    const hay = normalizeForMatch(event.text);
    if (!hay) continue;

    let score = 0;
    if (probe.length >= 40 && hay.includes(probe)) {
      score = 1;
    } else {
      const hayTokens = tokensOf(hay);
      if (hayTokens.size < 6) continue;
      let shared = 0;
      for (const token of needleTokens) if (hayTokens.has(token)) shared += 1;
      const jaccard = shared / (needleTokens.size + hayTokens.size - shared);
      if (jaccard >= 0.5) score = jaccard;
    }
    if (score > 0 && (!best || score > best.score)) best = { event, score };
  }
  return best?.event ?? null;
}

export function collectEscalationAnchors(escalation: string, events: Event[]): ScopeAnchor[] {
  const universe = deriveScopeUniverse(events);
  const anchors: ScopeAnchor[] = [];

  for (const match of escalation.matchAll(EMAIL_ADDRESS)) {
    const domain = match[1].toLowerCase();
    if (universe.senderDomains.includes(domain)) {
      anchors.push({ kind: "sender-domain", value: domain, source: "escalation" });
    }
  }
  for (const match of escalation.matchAll(TICKET_ANYWHERE)) {
    const prefix = match[1].toUpperCase();
    if (universe.ticketPrefixes.includes(prefix)) {
      anchors.push({ kind: "ticket-prefix", value: prefix, source: "escalation" });
    }
  }

  const linked = findEscalationEmail(escalation, events);
  if (linked) {
    const domain = linked.actor.match(EMAIL_DOMAIN)?.[1]?.toLowerCase();
    if (domain && universe.senderDomains.includes(domain)) {
      anchors.push({ kind: "sender-domain", value: domain, source: "escalation" });
    }
    for (const ref of linked.refs ?? []) {
      const prefix = ref.match(TICKET_KEY)?.[1]?.toUpperCase();
      if (prefix && universe.ticketPrefixes.includes(prefix)) {
        anchors.push({ kind: "ticket-prefix", value: prefix, source: "escalation" });
      }
    }
  }

  return dedupeAnchors(anchors);
}

interface ModelProposal {
  client: string | null;
  project: string | null;
  ticketPrefixes: string[];
  channels: string[];
  senderDomains: string[];
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

async function proposeFromModel(
  escalation: string,
  universe: ScopeUniverse,
  declaredClient: string | null,
  client: LlmClient,
): Promise<ModelProposal | null> {
  const user = [
    "Escalation message:",
    escalation.trim() || "(no escalation text was provided)",
    ...(declaredClient
      ? ["", `The manager states this escalation is from the client: ${declaredClient}. Prefer identifiers that belong to that client.`]
      : []),
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

  return {
    client: nameOf(parsed.client),
    project: nameOf(parsed.project),
    ticketPrefixes: stringList(parsed.ticketPrefixes)
      .filter((entry) => universe.ticketPrefixes.includes(entry.toUpperCase()))
      .map((entry) => entry.toUpperCase()),
    channels: stringList(parsed.channels).filter((entry) => universe.channels.includes(entry)),
    senderDomains: stringList(parsed.senderDomains).filter((entry) =>
      universe.senderDomains.includes(entry),
    ),
  };
}

function anchorComponents(anchors: ScopeAnchor[], events: Event[]): ScopeAnchor[][] {
  const parent = anchors.map((_, index) => index);
  const find = (index: number): number =>
    parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };

  for (let i = 0; i < anchors.length; i += 1) {
    for (let j = i + 1; j < anchors.length; j += 1) {
      if (events.some((event) => matchesAnchor(anchors[i], event) && matchesAnchor(anchors[j], event))) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, ScopeAnchor[]>();
  anchors.forEach((anchor, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), anchor]);
  });
  return [...groups.values()];
}

export async function resolveScope(
  escalation: string,
  events: Event[],
  client: LlmClient,
  declaredClient?: string | null,
): Promise<InvestigationScope | null> {
  const declared = declaredClient?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const universe = deriveScopeUniverse(events);
  const emptyUniverse =
    universe.ticketPrefixes.length === 0 &&
    universe.channels.length === 0 &&
    universe.senderDomains.length === 0;

  const escalationAnchors = collectEscalationAnchors(escalation, events);
  const proposal = emptyUniverse
    ? null
    : await proposeFromModel(escalation, universe, declared, client);

  const modelAnchors: ScopeAnchor[] = proposal
    ? [
        ...proposal.ticketPrefixes.map(
          (value): ScopeAnchor => ({ kind: "ticket-prefix", value, source: "model" }),
        ),
        ...proposal.channels.map(
          (value): ScopeAnchor => ({ kind: "channel", value, source: "model" }),
        ),
        ...proposal.senderDomains.map(
          (value): ScopeAnchor => ({ kind: "sender-domain", value, source: "model" }),
        ),
      ]
    : [];

  const declaredAnchor: ScopeAnchor | null = declared
    ? { kind: "declared-client", value: declared, source: "declared" }
    : null;

  const registryAnchors = dedupeAnchors([...escalationAnchors, ...modelAnchors]);

  if (registryAnchors.length === 0) {
    if (!declared) return null;
    return {
      client: declared,
      project: proposal?.project ?? null,
      ticketPrefixes: [],
      channels: [],
      senderDomains: [],
      confidence: "none",
      anchors: [declaredAnchor!],
    };
  }

  // Contradicting anchors (disjoint record sets) cannot all describe one
  // client: keep the component that carries escalation evidence, else the
  // largest, and cap confidence.
  let contradiction = false;
  let kept = registryAnchors;
  const components = anchorComponents(registryAnchors, events);
  if (components.length > 1) {
    contradiction = true;
    const evidenceComponent = components.find((component) =>
      component.some((anchor) => anchor.source === "escalation"),
    );
    kept =
      evidenceComponent ??
      components.reduce((best, current) => (current.length > best.length ? current : best), components[0]);
  }

  const anchors = dedupeAnchors([...(declaredAnchor ? [declaredAnchor] : []), ...kept]);
  const ticketPrefixes = [...new Set(kept.filter((a) => a.kind === "ticket-prefix").map((a) => a.value))];
  const channels = [...new Set(kept.filter((a) => a.kind === "channel").map((a) => a.value))];
  const senderDomains = [...new Set(kept.filter((a) => a.kind === "sender-domain").map((a) => a.value))];

  const total = kept.length + (declared ? 1 : 0);
  const confidence: ScopeConfidence =
    !contradiction && total >= SCOPED_MIN_ANCHORS ? "scoped" : "partial";

  return {
    client: declared ?? proposal?.client ?? null,
    project: proposal?.project ?? null,
    ticketPrefixes,
    channels,
    senderDomains,
    confidence,
    anchors,
  };
}
