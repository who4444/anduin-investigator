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
  /** The manager confirmed a partial scope before the run (G-12). */
  reviewed: boolean;
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
/* The domains that count as "the client" for recall purposes: the scope's
   verified domains, plus any registry domain whose name starts with a token
   of the declared client's name. Exported for the case-state builder, which
   needs the same client identity to find the last client contact (G-06). */
export function clientDomainsFor(events: Event[], scope: InvestigationScope | null): string[] {
  if (!scope) return [];
  return [...computeClientDomains(events, scope)].sort();
}

export function clientActorsFor(events: Event[], scope: InvestigationScope | null): string[] {
  if (!scope) return [];
  return clientEvidenceFor(events, scope).actors;
}

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

/* G-01: a client is not only an email domain. Slack users carry no address in
   the export; the only cross-source signal is the resolved display name
   (email "Dana Okafor <billing@…>" ↔ Slack "Dana Okafor"). Build the client's
   actor set from the names of everyone who wrote from a client domain, then
   treat that actor — and the channel they posted in — as client evidence. */
function normalizeActorName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function actorNames(event: Event): string[] {
  const names = [event.actor, event.actorResolved ?? ""].map(normalizeActorName).filter(Boolean);
  return [...new Set(names)];
}

export interface ClientEvidence {
  domains: string[];
  actors: string[];
  channels: string[];
  threads: string[];
  eventIds: string[];
}

function isClientActor(
  event: Event,
  domains: Set<string>,
  actors: Set<string>,
): boolean {
  const domain = actorEmailDomain(event);
  if (domain && domains.has(domain)) return true;
  return actorNames(event).some((name) => actors.has(name));
}

export function clientEvidenceFor(
  events: Event[],
  scope: InvestigationScope | null,
): ClientEvidence {
  if (!scope || scope.confidence === "none") {
    return { domains: [], actors: [], channels: [], threads: [], eventIds: [] };
  }

  const domains = computeClientDomains(events, scope);
  const actors = new Set<string>();
  for (const event of events) {
    const domain = actorEmailDomain(event);
    if (!domain || !domains.has(domain)) continue;
    for (const name of actorNames(event)) actors.add(name);
  }

  const channels = new Set<string>();
  const threads = new Set<string>();
  for (const event of events) {
    if (event.source === "email" && event.threadId && isClientActor(event, domains, actors)) {
      threads.add(event.threadId);
    }
    if (event.source === "slack" && isClientActor(event, domains, actors)) {
      channels.add(event.channel.toLowerCase());
    }
  }

  const eventIds = new Set<string>();
  for (const event of events) {
    if (isClientActor(event, domains, actors)) eventIds.add(event.id);
    if (event.source === "email" && event.threadId && threads.has(event.threadId)) {
      eventIds.add(event.id);
    }
    if (event.source === "slack" && channels.has(event.channel.toLowerCase())) {
      eventIds.add(event.id);
    }
  }

  return {
    domains: [...domains].sort(),
    actors: [...actors].sort(),
    channels: [...channels].sort(),
    threads: [...threads].sort(),
    eventIds: [...eventIds],
  };
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

  const client = clientEvidenceFor(events, scope);
  const forced = new Set(includeEventIds);

  // An email thread is one unit: a reply that cites no ticket of its own still
  // belongs to the escalation when its thread root does. The client's own
  // threads are always units, even when no anchor matched the root.
  const scopedThreads = new Set<string>(client.threads);
  for (const event of events) {
    if (event.source === "email" && event.threadId && matchScope(scope, event)) {
      scopedThreads.add(event.threadId);
    }
  }

  // Client evidence: direct authorship, threads the client wrote into, and
  // channels where a client identity posted. The channel rule is what keeps a
  // shared "general" room searchable when the client's Slack account has no
  // email address to match on.
  const clientEventIds = new Set(client.eventIds);
  const clientChannels = new Set(client.channels);

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
  const client = clientEvidenceFor(events, scope);
  const { outOfScope } = splitEventsByScope(events, scope);
  const clientEventIds = new Set(client.eventIds);
  const excluded = outOfScope.filter((event) => clientEventIds.has(event.id));
  return {
    clientDomains: client.domains,
    excludedEventIds: excluded.map((event) => event.id),
  };
}

export function scopePromptLine(scope: InvestigationScope | null): string | null {
  if (!scope || scope.confidence === "none") return null;
  const who = scope.client ?? "an unnamed client";
  const what = scope.project ?? "the escalation's project";
  return `Scope: this escalation is from ${who} about ${what}. The evidence registry may contain records for other clients and projects; only findings about this client and project belong in this investigation, and the source tools already hide out-of-scope records.`;
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

/* The resolved project name links to ticket prefixes the same way the
   declared client links to registry features: a prefix that spells the start
   of a project-name token ("Meridian" -> MER) belongs to that project. The
   model can miss it or propose a decoy (SUP-2231 is another project's ticket);
   the actual project's records must still be reachable by scope. */
function linkedToProject(project: string, universe: ScopeUniverse): ScopeAnchor[] {
  const tokens = clientTokens(project);
  if (tokens.length === 0) return [];
  const anchors: ScopeAnchor[] = [];
  for (const prefix of universe.ticketPrefixes) {
    const lower = prefix.toLowerCase();
    if (lower.length >= 2 && tokens.some((token) => token.startsWith(lower))) {
      anchors.push({ kind: "ticket-prefix", value: prefix.toUpperCase(), source: "linked" });
    }
  }
  return anchors;
}

/* Two records share evidence when they touch the same node — a ticket prefix,
   a channel, a sender domain, an actor name or an email thread. The scope
   graph is that adjacency (B1): seeds expand through it deterministically. */

type ScopeNodeKind = "prefix" | "channel" | "domain" | "actor" | "thread";

interface ScopeNode {
  kind: ScopeNodeKind;
  value: string;
}

function scopeNodeKey(node: ScopeNode): string {
  return `${node.kind}:${node.value}`;
}

function parsePrefixFromChannel(channel: string): string | null {
  return channel.match(TICKET_KEY)?.[1]?.toUpperCase() ?? null;
}

function recordGraphNodes(event: Event): ScopeNode[] {
  const nodes: ScopeNode[] = [];
  if (event.source === "jira") {
    const prefix = parsePrefixFromChannel(event.channel);
    if (prefix) nodes.push({ kind: "prefix", value: prefix });
  } else if (event.source === "slack") {
    if (event.channel) nodes.push({ kind: "channel", value: event.channel.toLowerCase() });
  } else if (event.source === "email") {
    const domain = event.actor.match(EMAIL_DOMAIN)?.[1]?.toLowerCase();
    if (domain) nodes.push({ kind: "domain", value: domain });
  }
  const actor = normalizeActorName(event.actorResolved ?? event.actor);
  if (actor) nodes.push({ kind: "actor", value: actor });
  for (const match of event.text.matchAll(TICKET_ANYWHERE)) {
    nodes.push({ kind: "prefix", value: match[1].toUpperCase() });
  }
  for (const ref of event.refs ?? []) {
    const prefix = ref.match(TICKET_KEY)?.[1]?.toUpperCase();
    if (prefix) nodes.push({ kind: "prefix", value: prefix });
  }
  if (event.threadId) nodes.push({ kind: "thread", value: event.threadId });
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = scopeNodeKey(node);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Node-key adjacency: two nodes are joined when a record touches both. */
function buildScopeGraph(events: Event[]): Map<string, Set<string>> {
  const recordNodesList = events.map(recordGraphNodes);
  const nodeRecords = new Map<string, Set<number>>();
  recordNodesList.forEach((nodes, index) => {
    for (const node of nodes) {
      const key = scopeNodeKey(node);
      if (!nodeRecords.has(key)) nodeRecords.set(key, new Set());
      nodeRecords.get(key)!.add(index);
    }
  });
  const neighbors = new Map<string, Set<string>>();
  for (const [key, records] of nodeRecords) {
    neighbors.set(key, new Set());
    for (const recordIndex of records) {
      for (const node of recordNodesList[recordIndex]) {
        neighbors.get(key)!.add(scopeNodeKey(node));
      }
    }
  }
  return neighbors;
}

/** B1 selection: expand every seed through the graph; several seed
    components all join (never drop an anchor for disjointness). Reached
    (non-seed) ACTOR nodes do not expand: one support engineer working many
    tenants must not merge them — a vendor engineer posting in a shared room
    cannot pull their other projects' tickets into this scope. Returns the
    selected nodes and how many DISJOINT seed components were found (a
    confidence cap, not a drop). */
function selectScopeNodes(
  events: Event[],
  seeds: ScopeNode[],
): { selected: Map<ScopeNodeKind, Set<string>>; seedComponents: number } {
  const neighbors = buildScopeGraph(events);
  const seedKeys = new Set(seeds.map(scopeNodeKey));
  const visited = new Set<string>();
  const selected = new Map<ScopeNodeKind, Set<string>>([
    ["prefix", new Set()],
    ["channel", new Set()],
    ["domain", new Set()],
    ["actor", new Set()],
    ["thread", new Set()],
  ]);
  let seedComponents = 0;
  for (const seed of seeds) {
    const key = scopeNodeKey(seed);
    if (visited.has(key) || !neighbors.has(key)) continue;
    seedComponents += 1;
    const queue = [key];
    visited.add(key);
    while (queue.length > 0) {
      const current = queue.pop()!;
      const [kind, ...rest] = current.split(":");
      selected.get(kind as ScopeNodeKind)?.add(rest.join(":"));
      for (const next of neighbors.get(current) ?? []) {
        if (visited.has(next)) continue;
        // Actor nodes join the component but only seed actors expand —
        // their authorship is the bridge; a reached human is not.
        if (next.startsWith("actor:") && !seedKeys.has(next)) {
          visited.add(next);
          continue;
        }
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return { selected, seedComponents };
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

  // B1: model proposals resolve the client/project NAMES only. Concrete
  // model anchors never drive selection — two plausible proposals must
  // produce the same scope, so the graph expands deterministic seeds alone.
  // (A model-spotted identifier the seeds miss comes back as a review
  // suggestion, not as scope.)

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
  const learnedProject = learned?.project ?? null;
  const learnedProjectAnchors = learnedProject ? linkedToProject(learnedProject, universe) : [];

  const declaredAnchor: ScopeAnchor | null = declared
    ? { kind: "declared-client", value: declared, source: "declared" }
    : null;

  const linkedAnchors = declared ? linkedToDeclared(declared, universe) : [];

  // The client's own evidence is a seed: actors writing from a client domain
  // bridge into whatever they authored — including a ticket they created.
  const clientSeedScope = {
    client: declared ?? learned?.client ?? null,
    project: learnedProject,
    ticketPrefixes: learned?.ticketPrefixes ?? [],
    channels: learned?.channels ?? [],
    senderDomains: learned?.senderDomains ?? [],
    confidence: "scoped",
    anchors: [],
  } satisfies InvestigationScope;
  const clientEvidence = clientEvidenceFor(events, clientSeedScope);

  const seedNodes: ScopeNode[] = [];
  for (const anchor of [...escalationAnchors, ...learnedAnchors, ...learnedProjectAnchors, ...linkedAnchors]) {
    const kind =
      anchor.kind === "ticket-prefix" ? "prefix" : anchor.kind === "channel" ? "channel" : "domain";
    // Case must match the graph's node keys: prefixes are uppercase.
    seedNodes.push({
      kind,
      value: kind === "prefix" ? anchor.value.toUpperCase() : anchor.value.toLowerCase(),
    });
  }
  for (const domain of clientEvidence.domains) seedNodes.push({ kind: "domain", value: domain });
  for (const actor of clientEvidence.actors) seedNodes.push({ kind: "actor", value: actor });

  const seedAnchors = dedupeAnchors([
    ...escalationAnchors,
    ...learnedAnchors,
    ...learnedProjectAnchors,
    ...linkedAnchors,
  ]);

  if (seedNodes.length === 0) {
    if (!declared) return null;
    return {
      client: declared,
      project: proposal?.project ?? learnedProject,
      ticketPrefixes: [],
      channels: [],
      senderDomains: [],
      confidence: "none",
      anchors: [declaredAnchor!],
    };
  }

  const { selected, seedComponents } = selectScopeNodes(events, seedNodes);
  // Disjoint seed components union here (everything selected) — they cap the
  // confidence instead of voting each other out.
  const contradiction = seedComponents > 1;

  const picked = (kind: ScopeNodeKind): string[] => [...selected.get(kind) ?? []];
  const ticketPrefixes = picked("prefix").sort();
  const channels = picked("channel").sort();
  const senderDomains = picked("domain").sort();

  // Seeds that touch no records select nothing: an honest none, not an
  // empty partial (the learned-identifiers-purged case).
  if (ticketPrefixes.length === 0 && channels.length === 0 && senderDomains.length === 0) {
    if (!declared) return null;
    return {
      client: declared,
      project: proposal?.project ?? learnedProject,
      ticketPrefixes: [],
      channels: [],
      senderDomains: [],
      confidence: "none",
      anchors: [declaredAnchor!],
    };
  }

  const anchors = dedupeAnchors([...(declaredAnchor ? [declaredAnchor] : []), ...seedAnchors]);
  const total = seedAnchors.length + (declared ? 1 : 0);
  const confidence: ScopeConfidence =
    !contradiction && total >= SCOPED_MIN_ANCHORS ? "scoped" : "partial";

  return {
    client: declared ?? proposal?.client ?? learned?.client ?? null,
    project: proposal?.project ?? learnedProject,
    ticketPrefixes,
    channels,
    senderDomains,
    confidence,
    anchors,
  };
}
