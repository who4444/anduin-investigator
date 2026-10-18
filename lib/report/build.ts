import type { Claim, Event, Gap, ReplyPayload, SkepticNote, SourceKind, Stage } from "../types";
import type { CoverageReport } from "../pipeline/coverage";
import type { ReportScope } from "../pipeline/scope";
import { NEGATIVE_VERIFY_ERRORS } from "../pipeline/negative";
import { buildCaseState, type CaseState } from "./case-state";
import type { Commitment } from "../types";
import type { BottomLine } from "./bottomline";
import type { Briefing } from "./briefing";
import type { ReportModel } from "./model";

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
  verification: "verified" | "supported";
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
  /** Every claim that states this promise (merged restatements included). */
  claimIds: string[];
  eventId: string | null;
  promise: string;
  who: string | null;
  toWhom: string | null;
  madeAt: string | null;
  deadline: string | null;
  /** The parsed deadline falls outside the evidence window: shown as an
      unverifiable date, never as a days-late number (G-04). */
  deadlineInvalid: boolean;
  outcome: string;
  daysLate: number | null;
  source: SourceKind | null;
  verification: "verified" | "supported";
  /** Sources disagree on the outcome; the failing reading wins (G-05). */
  contested: boolean;
  rationale: string | null;
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
  verification: "verified" | "supported";
  /** Set for negatives with a search-completeness caveat (G-03). */
  verifyError?: string | null;
}

export interface RejectedClaim {
  claimId: string;
  text: string;
  quote: string;
  reason: string;
  source: SourceKind | null;
}

/** G-23: one card per independent issue on the case overview. */
export interface IssueSummary {
  id: string;
  seq: number;
  title: string;
  ask: string;
  confidence: number;
  total: number;
  verified: number;
  supported: number;
  flagged: number;
  topFinding: string | null;
}

export interface ReportView {
  caseState: CaseState;
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
  investigation: {
    id: string;
    title: string;
    escalationText: string;
    createdAt: string;
    origin: string;
    ingestWarnings: string[];
  };
  events: Event[];
  /** Scope-excluded records offered for the manager's review/add-back (G-01). */
  excludedEvents: Event[];
  claims: Claim[];
  stats: { total: number; verified: number; supported: number; rejected: number; flagged: number };
  stages: Stage[];
  coverage: CoverageReport;
  gaps: Gap[];
  skepticNotes: SkepticNote[];
  verdict: string | null;
  reply: ReplyPayload | null;
  /** G-05: the canonical promise rows used by the ledger. */
  commitments?: Commitment[];
  /** G-08: the frozen top answer from this report version. */
  version: {
    number: number;
    narrative: string;
    createdAt: string;
    model: string | null;
    promptVersion: string | null;
  } | null;
  briefing: Briefing;
  bottomLine: BottomLine;
  /** Revision brief: the single normalized model every section renders. */
  model: ReportModel;
  scope: ReportScope | null;
  issues: IssueSummary[];
  activeIssueId: string | null;
  unassignedClaims: number;
  complete: boolean;
  /** Question groups with no verified/supported findings after all passes. */
  missing: string[];
}

export interface ReportInput {
  events: Event[];
  claims: Claim[];
  notes: SkepticNote[];
  /** G-05: structured commitments, when the run produced them. Absent
      (legacy/cached runs), the ledger falls back to clustering claims. */
  commitments?: Commitment[];
  /** G-06: the client's domains, for "last client contact". */
  clientDomains?: string[];
  /** G-01/G-04: the client's resolved actor names (email ↔ Slack identity). */
  clientActors?: string[];
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

/* A date-only claim ts is a day assertion, not an instant: when ordering or
   grouping, fall back to the record's own instant so date-only claims don't
   all pile at midnight ahead of same-day timestamps. */
export function effectiveTs(claim: Claim, event: Event | undefined): string {
  if (claim.ts && claim.ts.includes("T")) return claim.ts;
  return event?.ts ?? claim.ts ?? "";
}

function visibleClaims(claims: Claim[]): Claim[] {
  // A manager-reviewed claim (G-14) is no longer a finding: it leaves the
  // metrics, ledger, causes and story, and joins the rejected list instead.
  return claims.filter(
    (claim) =>
      (claim.verifyStatus === "verified" || claim.verifyStatus === "supported") &&
      !claim.review,
  );
}

function verificationOf(claim: Claim): "verified" | "supported" {
  return claim.verifyStatus === "verified" ? "verified" : "supported";
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

function shortenText(text: string, maxWords: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const words = flat.split(" ");
  const cut = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${cut}…` : cut;
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
  const commitments = visibleClaims(claims)
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

const ACTOR_EMAIL_DOMAIN = /@([A-Za-z0-9.-]+)/;

function normalizedActor(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function isClientReportEvent(
  event: Event,
  clientDomains: Set<string>,
  clientActors: Set<string>,
): boolean {
  const actor = event.actorResolved ?? event.actor;
  const domain = actor.match(ACTOR_EMAIL_DOMAIN)?.[1]?.toLowerCase();
  if (domain && clientDomains.has(domain)) return true;
  return [event.actor, event.actorResolved ?? ""].some((value) =>
    clientActors.has(normalizedActor(value)),
  );
}

export function buildMetrics(input: ReportInput): Metric[] {
  const { events, claims, notes } = input;
  const eventsById = eventMap(events);
  const clientDomains = new Set((input.clientDomains ?? []).map((domain) => domain.toLowerCase()));
  const clientActors = new Set((input.clientActors ?? []).map(normalizedActor).filter(Boolean));
  const kept = visibleClaims(claims);
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
      detail: "Fewer than two source-backed findings cite dated records.",
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

  // 3. commitments — one canonical ledger, shared with the promises section
  // and the bottom line. Structured commitments win; legacy runs fall back to
  // claim clusters inside buildLedger.
  const promiseLedger = buildLedger(input);
  const promiseTotal = promiseLedger.length;
  const keptPromises = promiseLedger.filter((row) => row.outcome === "kept").length;
  const brokenPromises = promiseLedger.filter((row) => row.outcome === "broken").length;
  const unclearPromises = promiseTotal - keptPromises - brokenPromises;
  const promiseClaimIds = new Set(promiseLedger.map((row) => row.claimId));
  const promiseEventIds = [
    ...new Set([
      ...claims.filter((claim) => promiseClaimIds.has(claim.id)).map((claim) => claim.eventId),
      ...((input.commitments ?? []).flatMap((commitment) => commitment.sourceEventIds)),
    ]),
  ];
  metrics.push({
    id: "commitments",
    label: "Commitments",
    value:
      promiseTotal === 0
        ? "none found"
        : brokenPromises > 0
          ? `${brokenPromises} of ${promiseTotal} broken`
          : keptPromises > 0
            ? `${keptPromises} of ${promiseTotal} kept`
            : `${unclearPromises} of ${promiseTotal} unclear`,
    detail:
      promiseTotal > 0
        ? `${keptPromises} kept · ${unclearPromises} unclear${brokenPromises > 0 ? ` · ${brokenPromises} broken` : ""} — same ledger as the promises section.`
        : undefined,
    judgment: false,
    determined: promiseTotal > 0,
    claimIds: [...promiseClaimIds],
    eventIds: promiseEventIds,
  });

  // 4. longest silence in the cited record (noise events must not set it)
  const orderedEvents = sortedByTs(citedEvents.map((entry) => entry.event));
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
      label: "Longest silence in the cited record",
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
      label: "Longest silence in the cited record",
      value: longest ? formatDays(longest.days) : "not determined",
      detail: "No gap of three days or more between cited records.",
      judgment: false,
      determined: Boolean(longest),
      claimIds: [],
      eventIds: longest ? [longest.from.id, longest.to.id] : [],
    });
  }

  // 5. unanswered chases: only the client can chase us. Internal runs are not
  // chases, and a non-client record between two client messages breaks the run.
  let longestRun: { actor: string; normalized: string; count: number; events: Event[] } = {
    actor: "",
    normalized: "",
    count: 0,
    events: [],
  };
  let run: { actor: string; normalized: string; count: number; events: Event[] } = {
    actor: "",
    normalized: "",
    count: 0,
    events: [],
  };
  const useClientIdentity = input.clientActors !== undefined || input.clientDomains !== undefined;
  for (const event of sortedByTs(events)) {
    const normalized = normalizedActor(event.actorResolved ?? event.actor);
    if (useClientIdentity && !isClientReportEvent(event, clientDomains, clientActors)) {
      run = { actor: "", normalized: "", count: 0, events: [] };
      continue;
    }
    if (run.normalized === normalized) {
      run.count += 1;
      run.events.push(event);
    } else {
      run = {
        actor: event.actorResolved ?? event.actor,
        normalized,
        count: 1,
        events: [event],
      };
    }
    if (run.count > longestRun.count) {
      longestRun = { ...run, events: [...run.events] };
    }
  }
  if (longestRun.count >= 2) {
    metrics.push({
      id: "chasers",
      label: "Unanswered chases from the client",
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
      label: "Unanswered chases from the client",
      value: "none found",
      detail: "No run of consecutive client records without an interleaved reply.",
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
    detail: "Classified from source-backed findings; see Ownership and causes.",
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

  // 8. handoffs with no documented handoff (any retrieved claim type may carry this)
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
  const kept = visibleClaims(claims);
  const failures = kept
    .filter((claim) => claim.type === "process_failure" || claim.type === "root_cause")
    .map((claim) => ({ text: claim.text, tag: tagForClaim(claim), claimId: claim.id }));
  return failures.slice(0, 5);
}

export function buildCauses({ claims }: ReportInput): Finding[] {
  // A negative with an incomplete search is a question, not a cause (G-03).
  const kept = visibleClaims(claims).filter(
    (claim) => claim.type !== "commitment" && claim.verifyError !== "evidence_incomplete",
  );
  return kept.map((claim) => ({ text: claim.text, tag: tagForClaim(claim), claimId: claim.id }));
}

export function buildActions(input: ReportInput): { immediate: ReportAction[]; followUp: ReportAction[] } {
  const { events, claims } = input;
  const eventsById = eventMap(events);
  const kept = visibleClaims(claims);
  const immediate: ReportAction[] = [];
  const followUp: ReportAction[] = [];

  const brokenCommitments = kept.filter(
    (claim) => claim.type === "commitment" && claim.status === "broken",
  );
  for (const claim of brokenCommitments.slice(0, 3)) {
    const stated = claim.text.replace(/^A /, "a ");
    // Long claim texts do not read as a sentence when wrapped in an imperative;
    // switch to a quotable form instead.
    immediate.push({
      text:
        stated.length > 80
          ? `Close out the broken promise — “${shortenText(stated, 16)}”. Set a dated plan or withdraw it in writing.`
          : `Re-commit to ${stated} with a dated plan, or withdraw it in writing.`,
      reason: "A source-backed promise reads as broken.",
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
      reason: "No broken promise or unanswered run was found in the source-backed findings.",
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
  // Every visible claim must cite a record the report actually shows; a claim
  // whose cited record is absent is dropped rather than given a fake source.
  const rows: TimelineClaimRow[] = visibleClaims(claims)
    .map((claim) => {
      const event = cited(claim, eventsById);
      if (!event) return null;
      return {
        kind: "claim" as const,
        claimId: claim.id,
        ts: effectiveTs(claim, event),
        actor: event.actorResolved ?? event.actor,
        source: event.source,
        text: claim.text,
        status: claim.status,
        flagged: claim.skepticFlag,
        judged: claim.type !== "root_cause" || claim.skepticFlag,
        verification: verificationOf(claim),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
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

/* Deadline extraction (G-04). Rules:
   - a deadline needs a day AND a month; a bare month token is not a deadline
     ("we ship by the end of March" promises no date),
   - months match only at word boundaries ("Marching" is not March),
   - named dates resolve against the record's timestamp; without a reference
     the year is never invented (no "now" fallback),
   - a named date more than half a year before its record means the next
     occurrence (a December promise about "Jan 5" is next January). */

const MONTH_PATTERN =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MONTH_FIRST = new RegExp(
  `\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  "i",
);
const DAY_FIRST = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?(?:,?\\s+(\\d{4}))?\\b`,
  "i",
);

const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DEADLINE_ROLLOVER_MS = 183 * DAY_MS;

function monthNumber(name: string): number {
  return MONTH_KEYS.indexOf(name.toLowerCase().slice(0, 3));
}

export function extractDeadline(
  text: string,
  referenceIso: string | null,
): { label: string; iso: string | null } | null {
  const isoMatch = text.match(ISO_DATE);
  if (isoMatch) {
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const parsed = Date.parse(`${isoMatch[0]}T23:59:59Z`);
    if (Number.isNaN(parsed)) return null;
    return { label: isoMatch[0], iso: new Date(parsed).toISOString() };
  }

  const monthFirst = text.match(MONTH_FIRST);
  const dayFirst = monthFirst ? null : text.match(DAY_FIRST);
  const match = monthFirst ?? dayFirst;
  if (!match) return null;

  const month = monthNumber(monthFirst ? match[1] : dayFirst![2]);
  const day = Number(monthFirst ? match[2] : dayFirst![1]);
  const explicitYear = monthFirst ? match[3] : dayFirst![3];
  if (month < 0 || day < 1 || day > 31) return null;

  const referenceMs = referenceIso ? Date.parse(referenceIso) : Number.NaN;
  const hasReference = !Number.isNaN(referenceMs);
  if (!explicitYear && !hasReference) return null;

  let year = explicitYear ? Number(explicitYear) : new Date(referenceMs).getUTCFullYear();
  let parsed = Date.UTC(year, month, day);
  if (!Number.isNaN(parsed) && !explicitYear && parsed < referenceMs - DEADLINE_ROLLOVER_MS) {
    year += 1;
    parsed = Date.UTC(year, month, day);
  }
  if (Number.isNaN(parsed)) return null;
  return { label: match[0].replace(/\s+/g, " ").trim(), iso: new Date(parsed).toISOString() };
}

export function buildLedger(input: ReportInput): LedgerRow[] {
  const { events } = input;
  const eventsById = eventMap(events);
  // The incident window bounds what "days late" can honestly mean.
  const timestamps = events
    .map((event) => Date.parse(event.ts))
    .filter((value) => !Number.isNaN(value));
  const windowDays =
    timestamps.length >= 2
      ? Math.ceil((Math.max(...timestamps) - Math.min(...timestamps)) / DAY_MS)
      : 0;

  // G-05: structured commitments are the canonical ledger. One commitment is
  // one promise; the store has already merged restatements and decided the
  // contested outcome.
  if (input.commitments && input.commitments.length > 0) {
    const claimsById = new Map(input.claims.map((claim) => [claim.id, claim]));
    return input.commitments
      .map((commitment) => {
        const claim = claimsById.get(commitment.claimId);
        if (
          !claim ||
          claim.review ||
          (claim.verifyStatus !== "verified" && claim.verifyStatus !== "supported")
        ) {
          return null;
        }
        const event = cited(claim, eventsById);
        const proofTs = event?.ts ?? claim.ts ?? null;
        const rawDaysLate =
          commitment.status === "broken" && commitment.deadlineIso && proofTs
            ? Math.max(
                0,
                Math.floor((Date.parse(proofTs) - Date.parse(commitment.deadlineIso)) / DAY_MS),
              )
            : null;
        const deadlineInvalid = rawDaysLate !== null && rawDaysLate > windowDays + 1;
        const row: LedgerRow = {
          claimId: claim.id,
          claimIds: [claim.id],
          eventId: claim.eventId,
          promise: claim.text,
          who: commitment.promisor ?? claim.actor ?? event?.actorResolved ?? event?.actor ?? null,
          toWhom: commitment.promisee,
          madeAt: event?.ts ?? claim.ts ?? null,
          deadline: commitment.deadlinePhrase,
          deadlineInvalid,
          outcome: commitment.status,
          daysLate: deadlineInvalid ? null : rawDaysLate,
          source: event?.source ?? null,
          verification: verificationOf(claim),
          contested: commitment.contested,
          rationale: commitment.rationale,
          mergedClaims:
            commitment.sourceEventIds.length > 1 ? commitment.sourceEventIds.length : undefined,
        };
        return row;
      })
      .filter((row): row is LedgerRow => row !== null)
      .sort((a, b) => ((a.madeAt ?? "") < (b.madeAt ?? "") ? -1 : 1));
  }

  return clusterCommitments(input.claims).map((cluster) => {
    const claim = cluster.representative;
    const event = cited(claim, eventsById);
    const deadline = extractDeadline(claim.text, claim.ts ?? event?.ts ?? null);
    const named = claim.text.match(/\bto ([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)?)/);
    const emailed = claim.text.match(/\bto\s+([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i);
    const toWhom =
      named?.[1] ??
      (emailed?.[1] ? `<${emailed[1]}>` : /\bto the client\b/i.test(claim.text) ? "the client" : null);
    // Lateness is anchored on the record that carries the promise, not on
    // whenever a later claim restated it.
    const proofTs = event?.ts ?? claim.ts ?? null;
    const rawDaysLate =
      claim.status === "broken" && deadline?.iso && proofTs
        ? Math.max(0, Math.floor((Date.parse(proofTs) - Date.parse(deadline.iso)) / DAY_MS))
        : null;
    // Lateness beyond the whole evidence window cannot be real: the parsed
    // date is a partial token or a wrong year. Fail closed to "invalid".
    const deadlineInvalid = rawDaysLate !== null && rawDaysLate > windowDays + 1;
    const statuses = [...new Set(cluster.members.map((member) => member.status))];
    return {
      claimId: claim.id,
      claimIds: cluster.members.map((member) => member.id),
      eventId: claim.eventId,
      promise: claim.text,
      who: claim.actor ?? event?.actorResolved ?? event?.actor ?? null,
      toWhom,
      madeAt: event?.ts ?? claim.ts ?? null,
      deadline: deadline ? deadline.label : null,
      deadlineInvalid,
      outcome: claim.status,
      daysLate: deadlineInvalid ? null : rawDaysLate,
      source: event?.source ?? null,
      verification: verificationOf(claim),
      contested: statuses.length > 1,
      rationale:
        statuses.length > 1 ? `sources disagree on the outcome (${statuses.join(" vs ")})` : null,
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
  const { events } = input;
  // Owner activity is every stored record, not only the ones claims cite —
  // otherwise uncited work looks like an ownerless stretch.
  const ordered = sortedByTs(events);

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
    verification: verificationOf(claim),
    verifyError: claim.verifyError ?? null,
  });

  const reviewed = claims.filter((claim) => claim.review);

  // Negatives are never "safe to repeat": the client pack must not assert an
  // absence, however well-supported (G-03 / new invariant in GAPS §9).
  const safeToRepeat = claims
    .filter(
      (claim) =>
        claim.verifyStatus === "verified" &&
        !claim.skepticFlag &&
        !claim.review &&
        !NEGATIVE_VERIFY_ERRORS.has(claim.verifyError ?? ""),
    )
    .map(signature);
  const checkWithHuman = claims
    .filter(
      (claim) =>
        !claim.review &&
        (claim.verifyStatus === "supported" ||
          (claim.verifyStatus === "verified" && claim.skepticFlag)),
    )
    .map(signature);
  const rejected = claims
    .filter((claim) => claim.verifyStatus === "rejected")
    .map((claim) => ({
      claimId: claim.id,
      text: claim.text,
      quote: claim.quote,
      reason: claim.verifyError ?? "quote_not_found",
      source: eventsById.get(claim.eventId)?.source ?? null,
    }));

  // Manager-reviewed claims join the audit list with their reason (G-14).
  for (const claim of reviewed) {
    const verdict = claim.review!.verdict.replace(/_/g, " ");
    rejected.push({
      claimId: claim.id,
      text: claim.text,
      quote: claim.quote,
      reason: `reviewed: ${verdict}${claim.review!.reason ? ` — ${claim.review!.reason}` : ""}`,
      source: eventsById.get(claim.eventId)?.source ?? null,
    });
  }

  return { safeToRepeat, checkWithHuman, rejected };
}

export function buildReportView(input: ReportInput): ReportView {
  return {
    caseState: buildCaseState(input),
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
