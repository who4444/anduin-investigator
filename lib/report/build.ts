import type { Claim, Event, Gap, SkepticNote, SourceKind, Stage } from "../types";
import type { CoverageReport } from "../pipeline/coverage";
import type { Briefing } from "./briefing";

export type FindingTag = "technical" | "process" | "communication";

export interface Metric {
  id: string;
  label: string;
  value: string;
  detail?: string;
  judgment: boolean;
  determined: boolean;
  claimIds: string[];
  eventIds: string[];
}

export interface Finding {
  text: string;
  tag: FindingTag;
  claimId: string;
}

export interface ReportAction {
  text: string;
  reason: string;
  claimIds: string[];
  eventIds: string[];
}

export interface TimelineClaimRow {
  kind: "claim";
  claimId: string;
  ts: string;
  actor: string;
  source: SourceKind;
  text: string;
  status: string;
  flagged: boolean;
  judged: boolean;
}

export interface TimelineSilenceRow {
  kind: "silence";
  from: string;
  to: string;
  days: number;
  label: string;
  eventIds: string[];
}

export type TimelineRow = TimelineClaimRow | TimelineSilenceRow;

export interface TimelineGroup {
  date: string;
  rows: TimelineRow[];
}

export interface LedgerRow {
  claimId: string;
  promise: string;
  who: string | null;
  toWhom: string | null;
  madeAt: string | null;
  deadline: string | null;
  outcome: string;
  daysLate: number | null;
  source: SourceKind | null;
  mergedClaims?: number;
}

export interface AuditRow {
  date: string;
  told: string;
  toldEventId: string;
  internal: string;
  internalEventId: string;
  note: string;
}

export interface LaneLapse {
  from: string;
  to: string;
  days: number;
  reason: string | null;
}

export interface Lane {
  actor: string;
  start: string;
  end: string;
  lapses: LaneLapse[];
}

export interface Signature {
  claimId: string;
  text: string;
  flagged: boolean;
  quote: string;
  source: SourceKind | null;
}

export interface RejectedClaim {
  claimId: string;
  text: string;
  quote: string;
  reason: string;
  source: SourceKind | null;
}

export interface ReportView {
  metrics: Metric[];
  failures: Finding[];
  actions: { immediate: ReportAction[]; followUp: ReportAction[] };
  timeline: TimelineGroup[];
  ledger: LedgerRow[];
  audit: AuditRow[];
  lanes: Lane[];
  causes: Finding[];
  safeToRepeat: Signature[];
  checkWithHuman: Signature[];
  rejected: RejectedClaim[];
}

export interface ReportPayload extends ReportView {
  investigation: { id: string; title: string; escalationText: string; createdAt: string };
  events: Event[];
  claims: Claim[];
  stats: { total: number; kept: number; excluded: number; flagged: number };
  stages: Stage[];
  coverage: CoverageReport;
  gaps: Gap[];
  skepticNotes: SkepticNote[];
  verdict: string | null;
  reply: { sentences: { text: string; claimIds: string[] }[] } | null;
  briefing: Briefing;
}

export interface ReportInput {
  events: Event[];
  claims: Claim[];
  notes: SkepticNote[];
}

const DAY_MS = 86_400_000;
const SILENCE_THRESHOLD_DAYS = 3;

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
}

export function tagForClaim(claim: Claim): FindingTag {
  if (claim.type === "root_cause") return "technical";
  if (/no reply|respond|responded|acknowledg|chaser|update|told/i.test(claim.text)) return "communication";
  return "process";
}

function verified(claims: Claim[]): Claim[] {
  return claims.filter((claim) => claim.verifyStatus === "kept");
}

function eventMap(events: Event[]): Map<string, Event> {
  return new Map(events.map((event) => [event.id, event]));
}

function cited(claim: Claim, eventsById: Map<string, Event>): Event | undefined {
  return eventsById.get(claim.eventId);
}

function sortedByTs<T extends { ts: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function formatDays(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* commitments: cluster near-duplicate promises so one promise is one  */
/* ledger row, and a failing outcome outweighs a "kept" reading        */
/* ------------------------------------------------------------------ */

const PROMISE_STOPWORDS = new Set([
  "the", "a", "an", "to", "in", "on", "of", "for", "by", "and", "will", "would", "be", "out",
  "that", "was", "is", "with", "his", "her", "their", "it", "this", "from", "as", "at", "into",
  "made", "promised", "commit", "committed", "would", "should", "after", "before", "then",
]);

function promiseTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !PROMISE_STOPWORDS.has(word)),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const STATUS_STANCE: Record<string, number> = { broken: 0, unclear: 1, "n/a": 2, kept: 3 };

export interface CommitmentCluster {
  representative: Claim;
  members: Claim[];
}

export function clusterCommitments(claims: Claim[], threshold = 0.45): CommitmentCluster[] {
  const commitments = verified(claims)
    .filter((claim) => claim.type === "commitment")
    .sort((a, b) => {
      const stance = (STATUS_STANCE[a.status] ?? 9) - (STATUS_STANCE[b.status] ?? 9);
      if (stance !== 0) return stance;
      const left = a.ts ?? "";
      const right = b.ts ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const clusters: { tokens: Set<string>; members: Claim[] }[] = [];
  for (const claim of commitments) {
    const tokens = promiseTokens(claim.text);
    const target = clusters.find((cluster) => similarity(cluster.tokens, tokens) >= threshold);
    if (target) {
      target.members.push(claim);
      for (const token of tokens) target.tokens.add(token);
    } else {
      clusters.push({ tokens, members: [claim] });
    }
  }

  return clusters
    .map((cluster) => ({
      representative: cluster.members[0],
      members: cluster.members,
    }))
    .sort((a, b) => {
      const left = a.representative.ts ?? "";
      const right = b.representative.ts ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

/* ------------------------------------------------------------------ */
/* metrics                                                             */
/* ------------------------------------------------------------------ */

export function buildMetrics({ events, claims, notes }: ReportInput): Metric[] {
  const eventsById = eventMap(events);
  const kept = verified(claims);
  const keptWithEvents = kept.filter((claim) => cited(claim, eventsById));
  const citedEvents = keptWithEvents
    .map((claim) => ({ claim, event: cited(claim, eventsById)! }))
    .sort((a, b) => (a.event.ts < b.event.ts ? -1 : a.event.ts > b.event.ts ? 1 : 0));
  const metrics: Metric[] = [];

  // 1. evidence window
  if (citedEvents.length >= 2) {
    const first = citedEvents[0].event;
    const last = citedEvents[citedEvents.length - 1].event;
    const days = daysBetween(first.ts, last.ts);
    metrics.push({
      id: "window",
      label: "Evidence window, first to latest cited record",
      value: formatDays(days),
      detail: `${first.ts.slice(0, 10)} → ${last.ts.slice(0, 10)}`,
      judgment: false,
      determined: true,
      claimIds: [citedEvents[0].claim.id, citedEvents[citedEvents.length - 1].claim.id],
      eventIds: [first.id, last.id],
    });
  } else {
    metrics.push({
      id: "window",
      label: "Evidence window, first to latest cited record",
      value: "not determined",
      detail: "Fewer than two verified findings cite dated records.",
      judgment: false,
      determined: false,
      claimIds: [],
      eventIds: [],
    });
  }

  // 2. time to first response (first cited record → next cited record by a different actor)
  const firstEntry = citedEvents[0];
  const responder = firstEntry
    ? citedEvents.find(
        (entry) => entry.event.ts > firstEntry.event.ts && entry.event.actor !== firstEntry.event.actor,
      )
    : undefined;
  if (firstEntry && responder) {
    const hours = Math.round((Date.parse(responder.event.ts) - Date.parse(firstEntry.event.ts)) / 3_600_000);
    metrics.push({
      id: "firstResponse",
      label: "First response after the first cited record",
      value: hours < 48 ? `${hours}h` : formatDays(Math.round(hours / 24)),
      detail: `${firstEntry.event.actor} → ${responder.event.actor}`,
      judgment: false,
      determined: true,
      claimIds: [firstEntry.claim.id, responder.claim.id],
      eventIds: [firstEntry.event.id, responder.event.id],
    });
  } else {
    metrics.push({
      id: "firstResponse",
      label: "First response after the first cited record",
      value: "not determined",
      detail: "No later cited record by a different person.",
      judgment: false,
      determined: false,
      claimIds: [],
      eventIds: [],
    });
  }

  // 3. commitments kept / total (deduplicated: one promise is one row)
  const clusters = clusterCommitments(claims);
  const keptClusters = clusters.filter((cluster) => cluster.representative.status === "kept");
  metrics.push({
    id: "commitments",
    label: "Commitments kept",
    value: clusters.length > 0 ? `${keptClusters.length} of ${clusters.length}` : "none found",
    detail:
      clusters.length > 0
        ? `Counted from ${clusters.length} distinct verified promise${clusters.length === 1 ? "" : "s"} (near-duplicates merged; a broken reading outweighs a kept one).`
        : undefined,
    judgment: false,
    determined: clusters.length > 0,
    claimIds: clusters.flatMap((cluster) => cluster.members.map((member) => member.id)),
    eventIds: clusters.flatMap((cluster) => cluster.members.map((member) => member.eventId)),
  });

  // 4. longest silence
  const orderedEvents = sortedByTs(events);
  let longest: { from: Event; to: Event; days: number } | null = null;
  for (let index = 1; index < orderedEvents.length; index += 1) {
    const from = orderedEvents[index - 1];
    const to = orderedEvents[index];
    const days = daysBetween(from.ts, to.ts);
    if (!longest || days > longest.days) longest = { from, to, days };
  }
  if (longest && longest.days >= SILENCE_THRESHOLD_DAYS) {
    metrics.push({
      id: "longestSilence",
      label: "Longest silence across all sources",
      value: formatDays(longest.days),
      detail: `after ${longest.from.actor}'s ${longest.from.source} record`,
      judgment: false,
      determined: true,
      claimIds: [],
      eventIds: [longest.from.id, longest.to.id],
    });
  } else {
    metrics.push({
      id: "longestSilence",
      label: "Longest silence across all sources",
      value: longest ? formatDays(longest.days) : "not determined",
      detail: "No gap of three days or more between stored records.",
      judgment: false,
      determined: Boolean(longest),
      claimIds: [],
      eventIds: longest ? [longest.from.id, longest.to.id] : [],
    });
  }

  // 5. unanswered run of cited messages by one person
  let longestRun: { actor: string; count: number; events: Event[] } = { actor: "", count: 0, events: [] };
  let run: { actor: string; count: number; events: Event[] } = { actor: "", count: 0, events: [] };
  for (const entry of citedEvents) {
    const event = entry.event;
    if (run.actor === event.actor) {
      run.count += 1;
      run.events.push(event);
    } else {
      run = { actor: event.actor, count: 1, events: [event] };
    }
    if (run.count > longestRun.count) longestRun = { ...run, events: [...run.events] };
  }
  if (longestRun.count >= 2) {
    metrics.push({
      id: "chasers",
      label: "Consecutive records from one person with no reply",
      value: `${longestRun.count} from ${longestRun.actor}`,
      detail: `${longestRun.events[0].ts.slice(0, 10)} → ${longestRun.events[longestRun.events.length - 1].ts.slice(0, 10)}`,
      judgment: false,
      determined: true,
      claimIds: keptWithEvents
        .filter((claim) => longestRun.events.some((event) => event.id === claim.eventId))
        .map((claim) => claim.id),
      eventIds: longestRun.events.map((event) => event.id),
    });
  } else {
    metrics.push({
      id: "chasers",
      label: "Consecutive records from one person with no reply",
      value: "none found",
      detail: "No cited person has two or more consecutive cited records without an interleaved reply.",
      judgment: false,
      determined: false,
      claimIds: [],
      eventIds: [],
    });
  }

  // 6. process failures (judgment)
  const processFailures = kept.filter((claim) => claim.type === "process_failure");
  metrics.push({
    id: "processFailures",
    label: "Process failures found",
    value: String(processFailures.length),
    detail: "Classified from verified findings; see Ownership and causes.",
    judgment: true,
    determined: processFailures.length > 0,
    claimIds: processFailures.map((claim) => claim.id),
    eventIds: processFailures.map((claim) => claim.eventId),
  });

  // 7. status accuracy: flagged findings whose record reads as a status update
  const statusConflicts = kept.filter(
    (claim) =>
      claim.skepticFlag &&
      (/resolved|on track|complete|shipped/i.test(claim.text) ||
        /resolved|on track|complete|shipped/i.test(eventsById.get(claim.eventId)?.text ?? "")),
  );
  metrics.push({
    id: "statusConflicts",
    label: "Times a status update conflicted with other evidence",
    value: statusConflicts.length > 0 ? String(statusConflicts.length) : "none found",
    detail: "Flagged by the skeptic review and matching a status-update reading.",
    judgment: true,
    determined: statusConflicts.length > 0,
    claimIds: statusConflicts.map((claim) => claim.id),
    eventIds: statusConflicts.map((claim) => claim.eventId),
  });

  // 8. handoffs with no documented handoff (any verified claim type may carry this)
  const handoffFailures = kept.filter((claim) =>
    /handoff|hand-off|on leave|leave|coverage|rota/i.test(claim.text),
  );
  metrics.push({
    id: "handoffs",
    label: "Handoffs with no documented handoff",
    value: handoffFailures.length > 0 ? String(handoffFailures.length) : "none found",
    detail: "Verified findings that read as leave or missing coverage.",
    judgment: true,
    determined: handoffFailures.length > 0,
    claimIds: handoffFailures.map((claim) => claim.id),
    eventIds: handoffFailures.map((claim) => claim.eventId),
  });

  // 9. skeptic findings (context for confidence)
  metrics.push({
    id: "skepticFindings",
    label: "Concerns raised in skeptic review",
    value: String(notes.length),
    judgment: true,
    determined: true,
    claimIds: notes.filter((note) => note.claimId).map((note) => note.claimId!),
    eventIds: notes.flatMap((note) => note.eventIds),
  });

  return metrics;
}

/* ------------------------------------------------------------------ */
/* failures, causes, actions                                           */
/* ------------------------------------------------------------------ */

export function buildFailures({ claims }: ReportInput): Finding[] {
  const kept = verified(claims);
  const failures = kept
    .filter((claim) => claim.type === "process_failure" || claim.type === "root_cause")
    .map((claim) => ({ text: claim.text, tag: tagForClaim(claim), claimId: claim.id }));
  return failures.slice(0, 5);
}

export function buildCauses({ claims }: ReportInput): Finding[] {
  const kept = verified(claims).filter((claim) => claim.type !== "commitment");
  return kept.map((claim) => ({ text: claim.text, tag: tagForClaim(claim), claimId: claim.id }));
}

export function buildActions(input: ReportInput): { immediate: ReportAction[]; followUp: ReportAction[] } {
  const { events, claims } = input;
  const eventsById = eventMap(events);
  const kept = verified(claims);
  const immediate: ReportAction[] = [];
  const followUp: ReportAction[] = [];

  const brokenCommitments = kept.filter(
    (claim) => claim.type === "commitment" && claim.status === "broken",
  );
  for (const claim of brokenCommitments.slice(0, 3)) {
    immediate.push({
      text: `Re-commit to ${claim.text.replace(/^A /, "a ")} with a dated plan, or withdraw it in writing.`,
      reason: "A verified promise reads as broken.",
      claimIds: [claim.id],
      eventIds: [claim.eventId],
    });
  }

  const metrics = buildMetrics(input);
  const chasers = metrics.find((metric) => metric.id === "chasers");
  if (chasers?.determined && chasers.eventIds.length > 0) {
    immediate.push({
      text: `Reply to the unanswered run of ${chasers.value}.`,
      reason: "Consecutive cited records from one person have no interleaved reply.",
      claimIds: chasers.claimIds,
      eventIds: chasers.eventIds,
    });
  }

  const statusConflicts = metrics.find((metric) => metric.id === "statusConflicts");
  if (statusConflicts?.determined && statusConflicts.eventIds.length > 0) {
    immediate.push({
      text: "Correct the status the client was given where internal evidence disagrees.",
      reason: "A status update was flagged against other evidence.",
      claimIds: statusConflicts.claimIds,
      eventIds: statusConflicts.eventIds,
    });
  }

  const handoffs = metrics.find((metric) => metric.id === "handoffs");
  if (handoffs?.determined && handoffs.eventIds.length > 0) {
    followUp.push({
      text: "Introduce a written handoff whenever an owner goes on leave.",
      reason: "Verified findings show leave or missing coverage with no handoff record.",
      claimIds: handoffs.claimIds,
      eventIds: handoffs.eventIds,
    });
  }

  const resolvedConflicts = kept.filter(
    (claim) =>
      claim.type === "process_failure" &&
      /resolved/i.test(eventsById.get(claim.eventId)?.text ?? "") &&
      claim.skepticFlag,
  );
  if (resolvedConflicts.length > 0) {
    followUp.push({
      text: "Require QA sign-off before an issue can be marked resolved.",
      reason: "A resolution was flagged while other evidence still showed failure.",
      claimIds: resolvedConflicts.map((claim) => claim.id),
      eventIds: resolvedConflicts.map((claim) => claim.eventId),
    });
  }

  if (immediate.length === 0) {
    immediate.push({
      text: "Send the client a dated update from the draft reply tab.",
      reason: "No broken promise or unanswered run was found in the verified findings.",
      claimIds: [],
      eventIds: [],
    });
  }

  return { immediate, followUp };
}

/* ------------------------------------------------------------------ */
/* timeline + silences                                                 */
/* ------------------------------------------------------------------ */

export function buildSilences(events: Event[], minimumDays = SILENCE_THRESHOLD_DAYS): TimelineSilenceRow[] {
  const ordered = sortedByTs(events);
  const silences: TimelineSilenceRow[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1];
    const to = ordered[index];
    const days = daysBetween(from.ts, to.ts);
    if (days < minimumDays) continue;
    silences.push({
      kind: "silence",
      from: from.ts,
      to: to.ts,
      days,
      label: `${formatDays(days)} with no stored activity. Last record: ${from.actor} in ${from.channel}.`,
      eventIds: [from.id, to.id],
    });
  }
  return silences;
}

export function buildTimeline(input: ReportInput): TimelineGroup[] {
  const { events, claims } = input;
  const eventsById = eventMap(events);
  const rows: TimelineClaimRow[] = verified(claims)
    .map((claim) => {
      const event = cited(claim, eventsById);
      return {
        kind: "claim" as const,
        claimId: claim.id,
        ts: claim.ts ?? event?.ts ?? "",
        actor: event ? event.actorResolved ?? event.actor : (claim.actor ?? "unknown"),
        source: (event?.source ?? "email") as SourceKind,
        text: claim.text,
        status: claim.status,
        flagged: claim.skepticFlag,
        judged: claim.type !== "root_cause" || claim.skepticFlag,
      };
    })
    .filter((row) => row.ts.length > 0);

  const groups: TimelineGroup[] = [];
  const byDate = new Map<string, TimelineRow[]>();
  for (const row of sortedByTs(rows)) {
    const date = row.ts.slice(0, 10);
    const list = byDate.get(date) ?? [];
    list.push(row);
    byDate.set(date, list);
  }

  for (const silence of buildSilences(events)) {
    const date = silence.from.slice(0, 10);
    const list = byDate.get(date) ?? [];
    list.push(silence);
    byDate.set(date, list);
  }

  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date)!;
    list.sort((a, b) => {
      const left = a.kind === "claim" ? a.ts : a.from;
      const right = b.kind === "claim" ? b.ts : b.from;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    groups.push({ date, rows: list });
  }

  return groups;
}

/* ------------------------------------------------------------------ */
/* ledger, audit, lanes, trust                                         */
/* ------------------------------------------------------------------ */

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const DATE_TOKEN = new RegExp(`(?:${MONTHS})\\s+\\d{1,2}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2} ${MONTHS}`, "i");

function extractDeadline(text: string, referenceIso: string | null): { label: string; iso: string | null } | null {
  const match = text.match(DATE_TOKEN);
  if (!match) return null;
  const label = match[0];

  let parsed: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    parsed = Date.parse(`${label}T23:59:59Z`);
  } else {
    const referenceYear = referenceIso
      ? new Date(referenceIso).getUTCFullYear()
      : new Date().getUTCFullYear();
    parsed = Date.parse(`${label} ${referenceYear} UTC`);
  }

  return { label, iso: Number.isNaN(parsed) ? null : new Date(parsed).toISOString() };
}

export function buildLedger(input: ReportInput): LedgerRow[] {
  const { events } = input;
  const eventsById = eventMap(events);
  return clusterCommitments(input.claims).map((cluster) => {
    const claim = cluster.representative;
    const event = cited(claim, eventsById);
    const deadline = extractDeadline(claim.text, claim.ts ?? event?.ts ?? null);
    const toWhomMatch = claim.text.match(/\bto ([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)?)/);
    const daysLate =
      claim.status === "broken" && deadline?.iso && claim.ts
        ? Math.max(0, Math.floor((Date.parse(claim.ts) - Date.parse(deadline.iso)) / DAY_MS))
        : null;
    return {
      claimId: claim.id,
      promise: claim.text,
      who: claim.actor ?? event?.actorResolved ?? event?.actor ?? null,
      toWhom: toWhomMatch ? toWhomMatch[1] : null,
      madeAt: event?.ts ?? claim.ts ?? null,
      deadline: deadline ? deadline.label : null,
      outcome: claim.status,
      daysLate,
      source: event?.source ?? null,
      mergedClaims: cluster.members.length > 1 ? cluster.members.length : undefined,
    };
  });
}

export function buildAudit({ notes, events }: ReportInput): AuditRow[] {
  const eventsById = eventMap(events);
  const rows: AuditRow[] = [];
  for (const note of notes) {
    if (note.kind !== "contradiction") continue;
    const citedItems = note.eventIds
      .map((id) => eventsById.get(id))
      .filter((event): event is Event => Boolean(event));
    if (citedItems.length < 2) continue;

    // Prefer an email as the communicated record, then a client-ish channel,
    // otherwise any record — contradictions without email still form an audit row.
    const told =
      citedItems.find((event) => event.source === "email") ??
      citedItems.find((event) => /client/i.test(event.channel)) ??
      citedItems[0];
    const internal = citedItems.find((event) => event.id !== told.id);
    if (!internal) continue;

    rows.push({
      date: told.ts.slice(0, 10),
      told: told.text,
      toldEventId: told.id,
      internal: internal.text,
      internalEventId: internal.id,
      note: note.text,
    });
  }
  return rows;
}

export function buildLanes(input: ReportInput): Lane[] {
  const { claims, events } = input;
  const eventsById = eventMap(events);
  const citedItems = verified(claims)
    .map((claim) => cited(claim, eventsById))
    .filter((event): event is Event => Boolean(event));
  const ordered = sortedByTs(citedItems);

  const byActor = new Map<string, Event[]>();
  for (const event of ordered) {
    const actor = event.actorResolved ?? event.actor;
    const list = byActor.get(actor) ?? [];
    list.push(event);
    byActor.set(actor, list);
  }

  const silences = buildSilences(events);

  return [...byActor.entries()]
    .map(([actor, items]) => {
      const lapses: LaneLapse[] = [];
      for (const silence of silences) {
        const covering = items.some(
          (item) => item.ts <= silence.from && item.ts >= silence.from.slice(0, 10),
        );
        if (!covering) continue;
        lapses.push({
          from: silence.from,
          to: silence.to,
          days: silence.days,
          reason: null,
        });
      }
      return {
        actor,
        start: items[0].ts,
        end: items[items.length - 1].ts,
        lapses,
      };
    })
    .sort((a, b) => (a.start < b.start ? -1 : 1));
}

export function buildTrust(input: ReportInput): {
  safeToRepeat: Signature[];
  checkWithHuman: Signature[];
  rejected: RejectedClaim[];
} {
  const { claims, events } = input;
  const eventsById = eventMap(events);
  const signature = (claim: Claim): Signature => ({
    claimId: claim.id,
    text: claim.text,
    flagged: claim.skepticFlag,
    quote: claim.quote,
    source: eventsById.get(claim.eventId)?.source ?? null,
  });

  const safeToRepeat = claims
    .filter((claim) => claim.verifyStatus === "kept" && !claim.skepticFlag)
    .map(signature);
  const checkWithHuman = claims
    .filter((claim) => claim.verifyStatus === "kept" && claim.skepticFlag)
    .map(signature);
  const rejected = claims
    .filter((claim) => claim.verifyStatus === "excluded")
    .map((claim) => ({
      claimId: claim.id,
      text: claim.text,
      quote: claim.quote,
      reason: claim.verifyError ?? "quote_not_found",
      source: eventsById.get(claim.eventId)?.source ?? null,
    }));

  return { safeToRepeat, checkWithHuman, rejected };
}

export function buildReportView(input: ReportInput): ReportView {
  return {
    metrics: buildMetrics(input),
    failures: buildFailures(input),
    actions: buildActions(input),
    timeline: buildTimeline(input),
    ledger: buildLedger(input),
    audit: buildAudit(input),
    lanes: buildLanes(input),
    causes: buildCauses(input),
    ...buildTrust(input),
  };
}
