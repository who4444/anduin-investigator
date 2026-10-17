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
  excludedClaims: number;
  /** Out-of-scope records authored by the client itself (G-01 invariant). */
  excludedClientRecords: number;
  excludedClientEventIds: string[];
  /** Records the manager added back from the excluded list ("included by review"). */
  includedByReview: number;
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
    // A ticket key mentioned or referenced in ANY record exists in the
    // registry — an engagement may live entirely in Slack/email.
    for (const match of event.text.matchAll(TICKET_ANYWHERE)) {
      prefixes.add(match[1].toUpperCase());
    }
    for (const ref of event.refs ?? []) {
      const match = ref.match(TICKET_KEY);
      if (match) prefixes.add(match[1].toUpperCase());
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

/* The declared client's name tokens ("northwind" in "Northwind Logistics")
   identify the client's own footprints in the registry. Same rule as the
   deterministic declared-client linking: a name must START with a token. */
function clientTokens(client: string): string[] {
  return client
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

function actorEmailDomain(event: Event): string | null {
  const actor = event.actorResolved ?? event.actor;
  return actor.match(EMAIL_DOMAIN)?.[1]?.toLowerCase() ?? null;
}

/* The domains that count as "the client" for recall purposes: the scope's
   verified domains, plus any registry domain whose name starts with a token
   of the declared client's name. */
function computeClientDomains(events: Event[], scope: InvestigationScope): Set<string> {
  const domains = new Set(scope.senderDomains.map((domain) => domain.toLowerCase()));
  if (scope.client) {
    const tokens = clientTokens(scope.client);
    for (const event of events) {
      const domain = actorEmailDomain(event);
      if (domain && tokens.some((token) => domain.startsWith(token))) domains.add(domain);
    }
  }
  return domains;
}

/* G-01: scoping is a recall guard first. The client's own evidence — records
   authored from a client domain, channels where a client identity posted,
   and the full email threads of client messages — stays in the investigation
   even when the anchor rules alone would exclude it. Records with no client
   footprint are still excluded, so other tenants in the same workspace never
   leak in. Manager-reviewed ids (`includeEventIds`) are always kept: the
   review is the human override over everything above. */
export function splitEventsByScope(
  events: Event[],
  scope: InvestigationScope | null,
  includeEventIds: string[] = [],
): { inScope: Event[]; outOfScope: Event[] } {
  if (!scope || scope.confidence === "none") return { inScope: events, outOfScope: [] };

  const clientDomains = computeClientDomains(events, scope);
  const forced = new Set(includeEventIds);

  // An email thread is one unit: a reply that cites no ticket of its own still
  // belongs to the escalation when its thread root does.
  const scopedThreads = new Set<string>();
  for (const event of events) {
    if (event.source === "email" && event.threadId && matchScope(scope, event)) {
      scopedThreads.add(event.threadId);
    }
  }

  // Client evidence: direct authorship, threads the client wrote into, and
  // channels where a client identity posted.
  const clientEventIds = new Set<string>();
  const clientChannels = new Set<string>();
  for (const event of events) {
    const domain = actorEmailDomain(event);
    if (!domain || !clientDomains.has(domain)) continue;
    clientEventIds.add(event.id);
    if (event.source === "email" && event.threadId) scopedThreads.add(event.threadId);
    if (event.source === "slack") clientChannels.add(event.channel.toLowerCase());
  }

  const inScope: Event[] = [];
  const outOfScope: Event[] = [];
  for (const event of events) {
    const inThread =
      event.source === "email" && event.threadId !== undefined && scopedThreads.has(event.threadId);
    const clientChannel =
      event.source === "slack" && clientChannels.has(event.channel.toLowerCase());
    (matchScope(scope, event) || inThread || clientEventIds.has(event.id) || clientChannel || forced.has(event.id)
      ? inScope
      : outOfScope
    ).push(event);
  }
  return { inScope, outOfScope };
}

/* Client evidence that did not survive the scope split. Non-empty means the
   report must disclose it as a blocking condition and refuse to draft a
   client reply (G-01 invariant). */
export function excludedClientEvidence(
  events: Event[],
  scope: InvestigationScope | null,
): { clientDomains: string[]; excludedEventIds: string[] } {
  if (!scope || scope.confidence === "none") return { clientDomains: [], excludedEventIds: [] };
  const clientDomains = computeClientDomains(events, scope);
  const { outOfScope } = splitEventsByScope(events, scope);
  const excluded = outOfScope.filter((event) => {
    const domain = actorEmailDomain(event);
    return domain !== null && clientDomains.has(domain);
  });
  return { clientDomains: [...clientDomains].sort(), excludedEventIds: excluded.map((event) => event.id) };
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
  declared: 5,
  escalation: 4,
  learned: 3,
  linked: 2,
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

/* Margin and distinctiveness guards for the escalation↔email match: canned
   support templates can score equally well against two different clients'
   emails, and boilerplate-only overlap must never found a scope anchor. */
const EMAIL_MARGIN = 0.15;
const DISCRIMINATIVE_DOC_MAX = 2;
const DISCRIMINATIVE_TOKEN_MIN = 4;

function findEscalationEmailCandidates(
  escalation: string,
  events: Event[],
): { event: Event; score: number }[] {
  const needle = normalizeForMatch(escalation);
  const needleTokens = tokensOf(needle);
  if (needleTokens.size < 6) return [];
  const probe = needle.slice(0, 80);

  const candidates: { event: Event; score: number }[] = [];
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
    if (score > 0) candidates.push({ event, score });
  }
  return candidates.sort((a, b) => b.score - a.score || (a.event.ts < b.event.ts ? -1 : 1));
}

function findEscalationEmail(escalation: string, events: Event[]): Event | null {
  const candidates = findEscalationEmailCandidates(escalation, events);
  if (candidates.length === 0) return null;

  // A near-tie between candidates means shared boilerplate, not identity.
  const best = candidates[0];
  const runnerUp = candidates[1];
  if (runnerUp && best.score - runnerUp.score < EMAIL_MARGIN) return null;

  // Require at least one shared token that is rare across the records —
  // a name, a ticket key, a specific phrase word — not template filler.
  const docCount = new Map<string, number>();
  for (const event of events) {
    for (const token of tokensOf(normalizeForMatch(event.text))) {
      docCount.set(token, (docCount.get(token) ?? 0) + 1);
    }
  }
  const bestTokens = tokensOf(normalizeForMatch(best.event.text));
  const shared = [...tokensOf(normalizeForMatch(escalation))].filter((token) => bestTokens.has(token));
  const discriminative = shared.some(
    (token) =>
      token.length >= DISCRIMINATIVE_TOKEN_MIN &&
      (docCount.get(token) ?? 0) <= DISCRIMINATIVE_DOC_MAX,
  );
  if (!discriminative) return null;

  return best.event;
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

/* The declared client is manager ground truth: link it to the registry's
   features deterministically instead of hoping the model does. A feature
   whose name STARTS with a declared token ("northwind.example" with
   "Northwind Logistics", "brightmarket.example" with "Bright Market") belongs
   to that client; a token merely appearing mid-name is not enough (a channel
   named vertex-billing must not match a declared "Billing Team"). */
function linkedToDeclared(declared: string, universe: ScopeUniverse): ScopeAnchor[] {
  const tokens = clientTokens(declared);
  if (tokens.length === 0) return [];

  const anchors: ScopeAnchor[] = [];
  for (const channel of universe.channels) {
    if (tokens.some((token) => channel.startsWith(token))) {
      anchors.push({ kind: "channel", value: channel, source: "linked" });
    }
  }
  for (const domain of universe.senderDomains) {
    if (tokens.some((token) => domain.startsWith(token))) {
      anchors.push({ kind: "sender-domain", value: domain, source: "linked" });
    }
  }
  return anchors;
}

/* Two anchors are bridged when their record sets share a record, or share an
   email thread — a reply that cites no ticket still ties its sender's domain
   to the ticket its root discusses. */
function anchorFootprint(anchor: ScopeAnchor, events: Event[]): Set<string> {
  const footprint = new Set<string>();
  for (const event of events) {
    if (!matchesAnchor(anchor, event)) continue;
    footprint.add(event.id);
    if (event.threadId) footprint.add(`t:${event.threadId}`);
  }
  return footprint;
}

function anchorComponents(anchors: ScopeAnchor[], events: Event[]): ScopeAnchor[][] {
  const parent = anchors.map((_, index) => index);
  const find = (index: number): number =>
    parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };

  const footprints = anchors.map((anchor) => anchorFootprint(anchor, events));
  for (let i = 0; i < anchors.length; i += 1) {
    for (let j = i + 1; j < anchors.length; j += 1) {
      let shared = false;
      for (const entry of footprints[i]) {
        if (footprints[j].has(entry)) {
          shared = true;
          break;
        }
      }
      if (shared) union(i, j);
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
  learned?: InvestigationScope | null,
): Promise<InvestigationScope | null> {
  const declaredRaw = declaredClient?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  // Punctuation noise ("&&&") must not count as a declared-client anchor.
  const declared = declaredRaw && /\p{L}/u.test(declaredRaw) ? declaredRaw : null;
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

  // Previously verified identifiers for a declared client count as evidence
  // again when they still exist in this registry; otherwise they are dropped.
  const learnedAnchors: ScopeAnchor[] = learned
    ? [
        ...learned.ticketPrefixes
          .filter((prefix) => universe.ticketPrefixes.includes(prefix.toUpperCase()))
          .map((value): ScopeAnchor => ({ kind: "ticket-prefix", value: value.toUpperCase(), source: "learned" })),
        ...learned.channels
          .filter((channel) => universe.channels.includes(channel.toLowerCase()))
          .map((value): ScopeAnchor => ({ kind: "channel", value: value.toLowerCase(), source: "learned" })),
        ...learned.senderDomains
          .filter((domain) => universe.senderDomains.includes(domain.toLowerCase()))
          .map((value): ScopeAnchor => ({ kind: "sender-domain", value: value.toLowerCase(), source: "learned" })),
      ]
    : [];

  const declaredAnchor: ScopeAnchor | null = declared
    ? { kind: "declared-client", value: declared, source: "declared" }
    : null;

  const linkedAnchors = declared ? linkedToDeclared(declared, universe) : [];
  const registryAnchors = dedupeAnchors([
    ...escalationAnchors,
    ...learnedAnchors,
    ...linkedAnchors,
    ...modelAnchors,
  ]);

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
  // client. Anchors carrying escalation evidence — or previously verified
  // identifiers for the declared client — are never dropped: when they span
  // multiple components, they are all kept and confidence is capped, so a
  // casual prose mention can never vote the real ticket out.
  let contradiction = false;
  let kept = registryAnchors;
  const components = anchorComponents(registryAnchors, events);
  if (components.length > 1) {
    contradiction = true;
    const evidenceComponents = components.filter((component) =>
      component.some((anchor) => anchor.source === "escalation" || anchor.source === "learned"),
    );
    kept =
      evidenceComponents.length > 0
        ? evidenceComponents.flat()
        : components.reduce((best, current) => (current.length > best.length ? current : best), components[0]);
  }

  const anchors = dedupeAnchors([...(declaredAnchor ? [declaredAnchor] : []), ...kept]);
  const ticketPrefixes = [...new Set(kept.filter((a) => a.kind === "ticket-prefix").map((a) => a.value))];
  const channels = [...new Set(kept.filter((a) => a.kind === "channel").map((a) => a.value))];
  const senderDomains = [...new Set(kept.filter((a) => a.kind === "sender-domain").map((a) => a.value))];

  const total = kept.length + (declared ? 1 : 0);
  const confidence: ScopeConfidence =
    !contradiction && total >= SCOPED_MIN_ANCHORS ? "scoped" : "partial";

  return {
    client: declared ?? proposal?.client ?? learned?.client ?? null,
    project: proposal?.project ?? learned?.project ?? null,
    ticketPrefixes,
    channels,
    senderDomains,
    confidence,
    anchors,
  };
}
