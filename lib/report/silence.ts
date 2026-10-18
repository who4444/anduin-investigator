import type { Claim, Commitment, Event, Gap, SkepticNote, SourceKind } from "../types";

export interface ClientEvidenceInput {
  domains: string[];
  actors: string[];
  channels: string[];
  threads: string[];
  eventIds: string[];
}

/* Shared record patterns. The case-state builder and the silence computation
   must agree on what counts as a status/assignee transition and a delivery. */
export const STATUS_TRANSITION = /^\s*Status:\s*(.+?)\s*→\s*(.+?)\s*$/;
export const ASSIGNEE_TRANSITION = /^\s*Assignee:\s*(.+?)\s*→\s*(.+?)\s*$/;
export const VERSION_TOKEN = /\b\d+\.\d+(?:\.\d+)?\b/;
export const FIX_WORD = /\b(?:fix(?:ed|es|ing)?|hotfix|patch(?:ed)?|corrected)\b/i;
export const DELIVERY_WORD =
  /\b(?:shipped|deployed|released|is live|went live|rolled out|included|corrected|fixed)\b/i;

/* Incident-relevant records (C5): the records that can set or break a
   timeline/silence window. Cited records, status/assignee transitions,
   client-authored messages and fix/release records are relevant; channel
   chatter and distractor noise never are. */
const QA_RECORD = /\bQA\b/i;
const QA_OUTCOME = /\b(?:failed|failing|passed|green|red|reopen(?:ed|ing)?)\b/i;

export function incidentRelevantEventIds(input: {
  events: Event[];
  claims: Claim[];
  commitments?: Commitment[];
  gaps?: Gap[];
  notes?: SkepticNote[];
}): Set<string> {
  const relevant = new Set<string>();
  for (const claim of input.claims) relevant.add(claim.eventId);
  for (const commitment of input.commitments ?? []) {
    for (const id of [...commitment.sourceEventIds, ...commitment.fulfilmentEventIds]) {
      relevant.add(id);
    }
  }
  for (const gap of input.gaps ?? []) {
    for (const id of gap.eventIds) relevant.add(id);
  }
  for (const note of input.notes ?? []) {
    for (const id of note.eventIds) relevant.add(id);
  }
  for (const event of input.events) {
    if (relevant.has(event.id)) continue;
    if (STATUS_TRANSITION.test(event.text) || ASSIGNEE_TRANSITION.test(event.text)) {
      relevant.add(event.id);
      continue;
    }
    if (QA_RECORD.test(event.text) && QA_OUTCOME.test(event.text)) {
      relevant.add(event.id);
      continue;
    }
    if (/escalat|chas(e|ing)|follow[- ]?up|still (wrong|blank|broken|failing)|no (reply|response|update)/i.test(event.text)) {
      relevant.add(event.id);
      continue;
    }
    if (VERSION_TOKEN.test(event.text) && FIX_WORD.test(event.text) && DELIVERY_WORD.test(event.text)) {
      relevant.add(event.id);
    }
  }
  return relevant;
}

/* ---- C5: the one silence computation ---- */

export interface SilenceWindow {
  from: string;
  to: string;
  days: number;
  label: string;
  /** The records bounding the window (for citations). */
  fromEventId?: string;
  toEventId?: string;
}

export interface Silences {
  /** Last client message → first vendor reply after it (or the horizon). */
  clientWait: (SilenceWindow & { clientActor: string; kind: "clientWait" }) | null;
  /** Longest gap between incident-relevant records. */
  project: (SilenceWindow & { kind: "project" }) | null;
  /** Longest gap per source among incident-relevant records. */
  bySource: Partial<Record<SourceKind, SilenceWindow & { kind: string }>>;
  /** The decision-impact headline: the client wait first, else the longest. */
  headline: (SilenceWindow & { kind: "clientWait" | "project" | "source" }) | null;
}

const DAY_MS = 86_400_000;
const MINIMUM_DAYS = 3;

function normalizedActorName(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function isClientEvidenceEvent(event: Event, evidence?: ClientEvidenceInput): boolean {
  if (!evidence) return false;
  if (evidence.eventIds.includes(event.id)) return true;
  const actor = event.actorResolved ?? event.actor;
  const domain = actor.match(/@([A-Za-z0-9.-]+)/)?.[1]?.toLowerCase();
  if (domain && evidence.domains.includes(domain)) return true;
  return evidence.actors.includes(normalizedActorName(actor));
}

function longestGap(records: Event[], label: string): SilenceWindow | null {
  let best: { from: Event; to: Event; days: number } | null = null;
  for (let index = 1; index < records.length; index += 1) {
    const days = Math.floor(
      (Date.parse(records[index].ts) - Date.parse(records[index - 1].ts)) / DAY_MS,
    );
    if (days < MINIMUM_DAYS) continue;
    if (!best || days > best.days) {
      best = { from: records[index - 1], to: records[index], days };
    }
  }
  if (!best) return null;
  return {
    from: best.from.ts,
    to: best.to.ts,
    days: best.days,
    fromEventId: best.from.id,
    toEventId: best.to.id,
    label: `${best.days} days, no incident activity — ${label} (between ${best.from.ts.slice(0, 10)} and ${best.to.ts.slice(0, 10)}; the records in between contain no incident activity)`,
  };
}

/** The ONE silence computation (C5): incident-relevant records only; the
    client wait, the project silence and per-source silences are distinct
    windows from the same object — never conflated. */
export function computeSilences(input: {
  events: Event[];
  claims: Claim[];
  commitments?: Commitment[];
  gaps?: Gap[];
  notes?: SkepticNote[];
  clientEvidence?: ClientEvidenceInput;
}): Silences {
  const relevant = incidentRelevantEventIds(input);
  const ordered = [...input.events]
    .filter((event) => relevant.has(event.id))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const project = ordered.length >= 2 ? (longestGap(ordered, "the incident timeline") ? { ...longestGap(ordered, "the incident timeline")!, kind: "project" as const } : null) : null;

  const bySource: Silences["bySource"] = {};
  const sources: SourceKind[] = ["jira", "email", "slack"];
  for (const source of sources) {
    const perSource = ordered.filter((event) => event.source === source);
    if (perSource.length >= 2) {
      const window = longestGap(perSource, `the ${source} record`);
      if (window) bySource[source] = { ...window, kind: "source" };
    }
  }

  let clientWait: Silences["clientWait"] = null;
  if (input.clientEvidence) {
    const lastClient = [...ordered].reverse().find((event) => isClientEvidenceEvent(event, input.clientEvidence));
    if (lastClient) {
      const replyAfter = ordered.find((event) => event.ts > lastClient.ts && !isClientEvidenceEvent(event, input.clientEvidence));
      const end = replyAfter?.ts ?? ordered[ordered.length - 1]?.ts ?? lastClient.ts;
      const days = Math.max(0, Math.floor((Date.parse(end) - Date.parse(lastClient.ts)) / DAY_MS));
      clientWait = {
        from: lastClient.ts,
        to: end,
        days,
        label: `${days} day${days === 1 ? "" : "s"} since the client's last message without a vendor reply`,
        clientActor: normalizedActorName(lastClient.actorResolved ?? lastClient.actor),
        kind: "clientWait",
      };
    }
  }

  let headline: Silences["headline"] = null;
  if (clientWait) {
    headline = { ...clientWait };
  } else if (project) {
    headline = { ...project, kind: "project" };
  } else {
    const longestSource = (Object.values(bySource) as (SilenceWindow & { kind: string })[])
      .sort((a, b) => b.days - a.days)[0];
    if (longestSource) headline = { ...longestSource, kind: "source" };
  }

  return { clientWait, project, bySource, headline };
}

/** B5/D1: the unanswered-chase run — the longest run of consecutive
    client-evidence records with no interleaved reply. Shared by the chasers
    metric and the story so both show the same number. Returns the run's
    events (empty when there is no run of 2+). */
export function chaseRun(
  events: Event[],
  isClientEvent: (event: Event) => boolean,
): { count: number; events: Event[]; actor: string } {
  const ordered = [...events].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  let best: { count: number; events: Event[]; actor: string } = { count: 0, events: [], actor: "" };
  let current: { count: number; events: Event[]; actor: string } = { count: 0, events: [], actor: "" };
  for (const event of ordered) {
    if (!isClientEvent(event)) {
      current = { count: 0, events: [], actor: "" };
      continue;
    }
    const actor = normalizedActorName(event.actorResolved ?? event.actor);
    if (current.actor === actor) {
      current = { count: current.count + 1, events: [...current.events, event], actor };
    } else {
      current = { count: 1, events: [event], actor };
    }
    if (current.count > best.count) best = { ...current, events: [...current.events] };
  }
  return best.count >= 2 ? best : { count: 0, events: [], actor: "" };
}
