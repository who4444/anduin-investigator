import type {
  Claim,
  Commitment,
  Event,
  Gap,
  InvestigationScope,
  SkepticNote,
  SourceKind,
} from "../types";
import { isPromiseLike } from "../pipeline/commitments";
import type { CoverageReport } from "../pipeline/coverage";
import { buildCaseState } from "./case-state";
import { computeSilences, type Silences } from "./silence";
import { detectContradictions, type Contradiction, type ClientEvidenceInput } from "./contradictions";
import { rankGaps, type GapTag } from "./gaps";

/* A2: a quote that was judged to REFUTE its claim is not a soft "needs check"
   — the quote does not support the claim at all. */
const NEGATIVE_REFUTE_ERRORS = new Set(["entailment_refutes"]);

/* The report revision brief: one normalized model is the source of truth for
   the page. Every count, role, state card, story sentence and compact link is
   computed here; components render this object and never re-derive facts from
   raw claims. */

export type ActorRole = "client" | "internal" | "unknown";
export type RoleSource = "roster" | "email_domain" | "channel" | "inferred";
export type FindingKind =
  | "event"
  | "promise"
  | "status_change"
  | "communication"
  | "technical_finding"
  | "process_failure";
export type FindingVerification = "verified" | "supported" | "unverified" | "rejected";
export type FindingImportance = "key" | "normal" | "routine";
export type FindingFlag = "needs_check" | "conflict";
export type FailureTag = "technical" | "process" | "communication";

export interface ReportActorModel {
  id: string;
  name: string;
  aliases: string[];
  role: ActorRole;
  roleSource: RoleSource;
  confidence: number;
  /** B4: why this role — the evidence the scorer weighed. */
  roleEvidence: string[];
}

export interface ReportFindingModel {
  id: string;
  /** Stable anchor for in-page links. */
  slug: string;
  kind: FindingKind;
  headline: string;
  text: string;
  /** Raw event text, used for status/assignee state only (never rendered). */
  eventText: string;
  actorIds: string[];
  eventActorId: string | null;
  ts: string;
  source: SourceKind;
  channel: string;
  issueId: string | null;
  claimIds: string[];
  /** The verbatim source quotes behind the finding, kept for the UI. */
  quotes: string[];
  eventIds: string[];
  verification: FindingVerification;
  /** A2: whether a manager may repeat this to the client. */
  clientSafe: boolean;
  importance: FindingImportance;
  flags: FindingFlag[];
  /** Exactly one exception pill; verified findings have null. */
  pill: FindingFlag | null;
  /** Tags apply only to failures. */
  failureTag: FailureTag | null;
  promiseStatus: "kept" | "broken" | "unclear" | "n/a" | null;
  deadline: string | null;
  /** Number of source records merged into this finding. */
  sourceCount: number;
}

export interface ReportStateField<T> {
  known: boolean;
  value: T | null;
  basis: string[];
  unknownReason: string | null;
  /** C1: how the value is known — a Jira transition, a message, a claim. */
  basisLabel?: string | null;
}

export interface ReportStateModel {
  asOf: string;
  currentStatus: ReportStateField<string>;
  owner: ReportStateField<string>;
  /** C1: who made the last status change, when no owner is recorded. */
  statusChangedBy: ReportStateField<string>;
  lastClientContact: ReportStateField<{ actor: string; ts: string }>;
  lastInternalUpdate: ReportStateField<{ actor: string; ts: string }>;
  latestFix: ReportStateField<{ text: string; ts: string }>;
  nextCommitment: ReportStateField<{ object: string; deadline: string | null }>;
}

export interface ReportCounts {
  findings: number;
  verified: number;
  needsCheck: number;
  openQuestions: number;
}

/** A3: the labelled pair behind every open-question display. */
export interface QuestionCounts {
  /** Grouped themes (the card count). */
  groups: number;
  /** Individual questions behind the themes (the details line). */
  raw: number;
}

export interface HeadlineSentence {
  text: string;
  findingIds: string[];
}

export interface ReportHeadline {
  sentences: HeadlineSentence[];
  statsLine: string;
  nextStep: string | null;
  tooThin: boolean;
}

export interface OpenQuestionGroup {
  id: string;
  theme: string;
  question: string;
  questions: string[];
  nextStep: string;
  impact: number;
  gapIds: string[];
  findingIds: string[];
  count: number;
}

export interface ReportActionModel {
  id: string;
  text: string;
  findingIds: string[];
  tone: "danger" | "neutral" | "warn";
}

export interface ReportSilence {
  from: string;
  to: string;
  days: number;
  label: string;
}

export interface ReportClientModel {
  resolved: boolean;
  /** B2: the client and the project resolve independently. */
  clientKnown: boolean;
  projectKnown: boolean;
  /** Readable project label: the explicit name or the selected scope units. */
  projectLabel: string | null;
  client: string | null;
  project: string | null;
  confidence: "scoped" | "partial" | "none" | null;
  reviewed: boolean;
  reasons: string[];
}

export interface ReportAuditRow {
  findingId: string;
  headline: string;
  note: string;
}

export interface ReportModel {
  title: string;
  client: ReportClientModel;
  actors: ReportActorModel[];
  findings: ReportFindingModel[];
  promises: ReportFindingModel[];
  failures: ReportFindingModel[];
  state: ReportStateModel;
  counts: ReportCounts;
  questionCounts: QuestionCounts;
  /** C3: deterministic contradiction detectors (the audit's first rows). */
  contradictions: Contradiction[];
  /** C5: all three silence windows from the one computation. */
  silences: Silences;
  headline: ReportHeadline;
  verifiedFindings: ReportFindingModel[];
  /** Verified in code but excluded from safe copy because a conflict pill applies. */
  withheldVerified: ReportFindingModel[];
  actions: ReportActionModel[];
  openQuestions: OpenQuestionGroup[];
  silence: ReportSilence | null;
  audit: ReportAuditRow[];
  /** True when more than 60% of findings carry the same exception pill. */
  suppressPills: boolean;
  pillSummary: string | null;
  processNormsNote: string | null;
}

export interface ReportModelInput {
  investigation: { title: string; escalationText: string; createdAt: string };
  events: Event[];
  claims: Claim[];
  commitments?: Commitment[];
  gaps: Gap[];
  notes: SkepticNote[];
  scope: (InvestigationScope & { reviewed?: boolean }) | null;
  clientDomains?: string[];
  clientActors?: string[];
  coverage?: CoverageReport;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_IN_ANGLE = /<\s*[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\s*>/g;
const EMAIL = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const STATUS_TRANSITION = /^\s*Status:\s*(.+?)\s*→\s*(.+?)\s*$/;
const ASSIGNEE_TRANSITION = /^\s*Assignee:\s*(.+?)\s*→\s*(.+?)\s*$/;
const VERSION_TOKEN = /\b\d+\.\d+(?:\.\d+)?\b/;
const FIX_WORD = /\b(?:fix(?:ed|es|ing)?|hotfix|patch(?:ed)?|corrected)\b/i;
const QA_EVENT = /\bQA\b/i;
const UNANSWERED = /\b(?:no reply|unanswered|no response|chase|chaser|follow(?:ed)? up|awaiting)\b/i;
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "by", "with", "is", "was",
  "were", "are", "be", "been", "has", "have", "had", "it", "this", "that", "as", "at", "from",
  "after", "before", "since", "still", "we", "our", "they", "their", "he", "she", "his", "her",
  "i", "you", "not", "no", "but", "if", "then", "than", "so", "up", "out", "into", "about",
]);

function normalizeName(value: string): string {
  return decodeEntities(value)
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function displayName(value: string): string {
  const decoded = decodeEntities(value);
  const withoutAngle = decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (withoutAngle) return withoutAngle;
  const email = decoded.match(EMAIL)?.[0];
  if (!email) return decoded.trim();
  const local = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function emailDomain(value: string): string | null {
  return decodeEntities(value).match(/@([A-Za-z0-9.-]+)/)?.[1]?.toLowerCase() ?? null;
}

function stripEmailText(text: string, actors: ReportActorModel[]): string {
  let output = decodeEntities(text).replace(EMAIL_IN_ANGLE, "").replace(UUID, "");
  output = output.replace(EMAIL, (address) => {
    const name = actors.find((actor) =>
      actor.aliases.some((alias) => normalizeName(alias) === normalizeName(displayName(address))),
    )?.name;
    return name ?? "a participant";
  });
  return output.replace(/\s+/g, " ").trim();
}

function cleanHumanText(text: string): string {
  return text
    .replace(UUID, "")
    .replace(/^\s*issue created:\s*/i, "")
    .replace(
      /^(?:commitment|ownership|root cause|process failure|technical|decision|communication|status)\s+finding:\s*/i,
      "",
    )
    .replace(/^\s*[A-Z][A-Z0-9]{1,9}-\d+\s*[:|-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanReportTitle(value: string): string {
  const cleaned = value
    .replace(UUID, "")
    .replace(/\bissue created:\s*/gi, "")
    .replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, "")
    .replace(/^\s*[:|-]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Investigation report";
}

function words(text: string, limit: number): string {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length <= limit) return parts.join(" ");
  return `${parts.slice(0, limit).join(" ")}…`;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/* Promise texts often restate the promisor ("Ravi Menon committed the VAT fix
   to the Sep 20 release"). The label already names the actor, so drop the
   self-reference instead of printing "Ravi Menon promised Ravi Menon ...". */
/* Promise texts often restate the promisor ("Ravi Menon committed the VAT fix
   to the Sep 20 release"). The label already names the actor, so drop the
   self-reference (and keep its verb) instead of printing "Ravi Menon promised
   Ravi Menon committed ...". */
function stripSelfReference(
  text: string,
  actorName: string,
): { rest: string; verb: string | null } {
  const first = actorName.split(/\s+/)[0];
  const names = [...new Set([actorName, first])]
    .filter((name) => name.length > 1)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (names.length === 0) return { rest: text, verb: null };
  const pattern = new RegExp(
    `^(?:${names.join("|")})\\b(?:\\s*\\([^)]{0,40}\\))?\\s+(?:has\\s+|had\\s+)?(promised|promises|commits?|committed|agreed|agrees|told|said|stated|confirmed|reported|announced)\\b(?:\\s*\\([^)]{0,60}\\))?(?:\\s+(?:that|to))?\\s+`,
    "i",
  );
  const match = text.match(pattern);
  if (!match) return { rest: text, verb: null };
  const rest = text.slice(match[0].length).trim();
  return rest ? { rest, verb: match[1].toLowerCase() } : { rest: text, verb: null };
}

/* Only real verb forms count as a promise statement: a text that opens with
   "Commitment ..." or "Promise ..." is a noun phrase, not a promise sentence. */
const PROMISE_VERB_LEAD = /^(?:promis(?:e|es|ed|ing)|commit(?:s|ted|ting)?|agree(?:s|d|ing)?)\b/i;

/* The label source: the full cleaned finding text (the old headline was
   word-capped, which left even the drawer's "full" label cut). The actor name
   is kept in front of very short texts, matching the old headline behavior. */
function labelSource(finding: ReportFindingModel, actorName: string | null): string {
  return actorName && actorName !== "Someone" && wordCount(finding.text) < 6
    ? `${actorName}: ${finding.text}`
    : finding.text;
}

/* Both label sizes derive from one source, so the short label is always
   exactly the capped prefix of the full one — "see more" opens the rest. */
function labelFor(finding: ReportFindingModel, actors: ReportActorModel[], full: boolean): string {
  const actor = actors.find((entry) => entry.id === finding.eventActorId)?.name;
  if (finding.kind === "status_change") {
    const assignee = finding.eventText.match(ASSIGNEE_TRANSITION);
    if (assignee) return `${assignee[2].trim()} took ownership`;
    const status = finding.eventText.match(STATUS_TRANSITION);
    if (status) return `Status became ${status[2].trim()}`;
  }
  if (finding.kind === "promise") {
    const actorName = actor ?? "Someone";
    const { rest, verb } = stripSelfReference(cleanHumanText(finding.text), actorName);
    if (verb) return `${actorName} ${verb} ${full ? rest : words(rest, 5)}`;
    if (PROMISE_VERB_LEAD.test(rest)) return `${actorName} ${full ? rest : words(rest, 6)}`;
    return `${actorName}: ${full ? rest : words(rest, 5)}`;
  }
  const base = labelSource(finding, actor ?? null);
  if (finding.failureTag) {
    return `${finding.failureTag} failure: ${full ? base : words(base, 4)}`;
  }
  return full ? base : words(base, 5);
}

function shortLabelFor(finding: ReportFindingModel, actors: ReportActorModel[]): string {
  return labelFor(finding, actors, false);
}

function findingTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function similarity(left: string, right: string): number {
  const a = findingTokens(left);
  const b = findingTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

function ticketRefs(...texts: string[]): Set<string> {
  const refs = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g)) refs.add(match[0].toUpperCase());
  }
  return refs;
}

function isStateRelevant(event: Event): boolean {
  return (
    STATUS_TRANSITION.test(event.text) ||
    ASSIGNEE_TRANSITION.test(event.text) ||
    QA_EVENT.test(event.text) ||
    (VERSION_TOKEN.test(event.text) && FIX_WORD.test(event.text))
  );
}

function claimTypePriority(claim: Claim | undefined): number {
  if (!claim) return 9;
  if (claim.type === "process_failure") return 0;
  if (claim.type === "root_cause") return 1;
  if (claim.type === "commitment") return 2;
  if (claim.type === "ownership") return 3;
  if (claim.type === "decision") return 4;
  return 5;
}

/* A1: an event's claims are assertion clusters — the same statement restated
   across investigators keeps its strongest verified state, and a supported
   restatement never downgrades a verified one. Incompatible assertions
   ("resolved" vs "still failing") raise a conflict instead of choosing. */
const CLAIM_STATE_RANK: Record<FindingVerification, number> = {
  verified: 3,
  supported: 2,
  unverified: 1,
  rejected: 0,
};

function representativeVerification(claims: Claim[]): { state: FindingVerification; incompatible: boolean } {
  let state: FindingVerification = "unverified";
  for (const claim of claims) {
    const rank = CLAIM_STATE_RANK[claim.verifyStatus] ?? 1;
    if (rank > CLAIM_STATE_RANK[state]) state = claim.verifyStatus;
  }
  const positive = claims.some((claim) =>
    /\b(?:marked|was|is|got)\s+(?:resolved|closed|fixed)|\b(?:resolved|fixed|verified|passed)\b/i.test(claim.text),
  );
  const negative = claims.some((claim) =>
    /\bstill\s+(?:wrong|failing|blank|broken|open)|\bnot\s+(?:fixed|resolved|shipped)|\bdid not\s+(?:fix|ship)|\bQA\s+(?:still\s+)?(?:is\s+)?failing|unanswered|no reply/i.test(claim.text),
  );
  return { state, incompatible: positive && negative };
}

function kindFor(event: Event, claim: Claim | undefined): FindingKind {
  if (claim?.type === "process_failure") {
    return /no reply|unanswered|chase|respond|response/i.test(claim.text)
      ? "process_failure"
      : "process_failure";
  }
  if (STATUS_TRANSITION.test(event.text) || ASSIGNEE_TRANSITION.test(event.text)) return "status_change";
  if (claim?.type === "commitment") return "promise";
  if (claim?.type === "root_cause") return "technical_finding";
  if (claim && /no reply|unanswered|respond|told|email|chase/i.test(claim.text)) return "communication";
  if (event.source === "email") return "communication";
  return "event";
}

function failureTagFor(kind: FindingKind, text: string): FailureTag | null {
  if (kind === "process_failure") return UNANSWERED.test(text) ? "communication" : "process";
  if (kind === "technical_finding") return "technical";
  return null;
}

function promiseStatusFor(
  claim: Claim | undefined,
  commitment: Commitment | undefined,
): "kept" | "broken" | "unclear" | "n/a" | null {
  if (commitment) return commitment.status === "withdrawn" ? "unclear" : commitment.status;
  if (claim?.type === "commitment") return claim.status;
  return null;
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function headlineFor(
  kind: FindingKind,
  event: Event,
  text: string,
  actorName: string | null,
  statusValue?: string,
  assignee?: string,
): string {
  if (kind === "status_change") {
    if (assignee) return `${assignee} took ownership of ${event.channel}`;
    if (statusValue) return `${event.channel} marked ${statusValue} on ${dateOnly(event.ts)}`;
  }
  const human = cleanHumanText(text);
  const base = words(human, wordCount(human) < 6 ? 6 : 9);
  if (wordCount(base) >= 6) return base;
  if (actorName) return `${actorName}: ${base}`;
  return base || `${event.channel} recorded an update`;
}

function actorKey(name: string): string {
  return normalizeName(displayName(name)) || normalizeName(name) || "unknown";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildActors(input: ReportModelInput): {
  actors: ReportActorModel[];
  byName: Map<string, ReportActorModel>;
  byId: Map<string, ReportActorModel>;
  resolved: boolean;
} {
  const scope = input.scope;
  const resolved = Boolean(scope?.client && scope.confidence !== "none");
  const clientDomains = new Set((input.clientDomains ?? []).map((domain) => domain.toLowerCase()));
  const clientActorNames = new Set((input.clientActors ?? []).map(normalizeName).filter(Boolean));
  const rawActors = new Map<string, { display: string; aliases: Set<string> }>();
  const activity = new Map<string, { jira: boolean; slack: boolean; email: boolean }>();
  const add = (raw: string | null | undefined, source?: SourceKind) => {
    if (!raw) return;
    const key = actorKey(raw);
    if (!key) return;
    const existing = rawActors.get(key) ?? { display: displayName(raw), aliases: new Set<string>() };
    existing.aliases.add(decodeEntities(raw).trim());
    if (!existing.display) existing.display = displayName(raw);
    rawActors.set(key, existing);
    if (source) {
      const seen = activity.get(key) ?? { jira: false, slack: false, email: false };
      seen[source] = true;
      activity.set(key, seen);
    }
  };
  for (const event of input.events) {
    add(event.actor, event.source);
    add(event.actorResolved ?? null, event.source);
  }
  for (const claim of input.claims) add(claim.actor ?? null);

  // Internal names are addresses from a non-client domain once the client is
  // identified. Before that every role is unknown.
  const internalNames = new Set<string>();
  if (resolved) {
    for (const [key, actor] of rawActors) {
      for (const alias of actor.aliases) {
        const domain = emailDomain(alias);
        if (domain && !clientDomains.has(domain)) internalNames.add(key);
      }
    }
  }

  const actors: ReportActorModel[] = [];
  const byName = new Map<string, ReportActorModel>();
  // B4: recipient-direction evidence. A client-domain sender whose emails
  // address the vendor's domain is the client talking to their vendor (strong
  // client evidence); one whose recorded emails never leave the client's own
  // domains while doing vendor-side work (Jira/Slack) is the identity trap.
  const recipientDomains = new Map<string, Set<string>>();
  for (const event of input.events) {
    if (event.source !== "email") continue;
    const key = actorKey(event.actorResolved ?? event.actor);
    if (!recipientDomains.has(key)) recipientDomains.set(key, new Set());
    const meta = event.meta as { to?: unknown; cc?: unknown } | undefined;
    for (const list of [meta?.to, meta?.cc]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry !== "string") continue;
        const domain = entry.match(EMAIL)?.[1]?.toLowerCase() ?? (entry.includes("@") ? entry.split("@")[1]?.toLowerCase() : null);
        if (domain) recipientDomains.get(key)!.add(domain);
      }
    }
  }
  const vendorDomains = new Set<string>();
  for (const [key, targets] of recipientDomains) {
    const senderDomains = [...(rawActors.get(key)?.aliases ?? [])]
      .map(emailDomain)
      .filter((domain): domain is string => Boolean(domain));
    if (!senderDomains.some((domain) => clientDomains.has(domain))) continue;
    for (const domain of targets) if (!clientDomains.has(domain)) vendorDomains.add(domain);
  }
  for (const [key, actor] of rawActors) {
    const aliases = [...actor.aliases];
    const domains = aliases.map(emailDomain).filter((domain): domain is string => Boolean(domain));
    const nameAsClient = clientActorNames.has(key);
    const domainIsClient = domains.some((domain) => clientDomains.has(domain));
    const domainIsInternal = domains.some((domain) => !clientDomains.has(domain));
    const channels = activity.get(key) ?? { jira: false, slack: false, email: false };
    const targets = recipientDomains.get(key) ?? new Set<string>();
    const emailsToVendor = [...targets].some((domain) => vendorDomains.has(domain) && !clientDomains.has(domain));
    const vendorSideActivity = channels.jira || channels.slack;
    const evidence: string[] = [];
    if (domainIsClient) evidence.push("writes from the client's domain");
    if (emailsToVendor) evidence.push("their emails address the vendor");
    if (channels.slack) evidence.push("posts in the project channels");
    if (channels.jira) evidence.push("works the Jira records");
    if (channels.email && !domainIsClient) evidence.push("writes from a vendor or other domain");
    if (nameAsClient && !domains.length) evidence.push("listed as a client contact");
    let role: ActorRole = "unknown";
    let roleSource: RoleSource = "inferred";
    let confidence = 0.25;
    if (resolved) {
      if (domainIsClient && emailsToVendor) {
        role = "client";
        roleSource = "email_domain";
        confidence = 0.95;
      } else if (domainIsClient && !vendorSideActivity && !emailsToVendor) {
        // A client-domain writer with no vendor-side activity at all: the
        // address is the strongest signal available.
        role = "client";
        roleSource = "email_domain";
        confidence = 0.8;
      } else if (nameAsClient && domains.length === 0 && !vendorSideActivity) {
        role = "client";
        roleSource = "channel";
        confidence = 0.85;
      } else if (
        domainIsClient &&
        vendorSideActivity &&
        targets.size > 0 &&
        !emailsToVendor
      ) {
        // B4 trap: a client-domain address whose recorded emails never
        // addressed the vendor while they work the vendor's channels/records.
        // That is vendor work under a client-domain alias.
        role = "internal";
        roleSource = "inferred";
        confidence = 0.6;
        evidence.push("their recorded emails never address the vendor — vendor work under a client-domain alias");
      } else if (domainIsClient && targets.size === 0) {
        // No envelope data at all: fall back to the domain plus channel
        // conflict check — a client-domain writer who never posts in the
        // project channels is the client; one who does stays unlabelled.
        if (channels.slack) {
          role = "unknown";
          roleSource = "inferred";
          confidence = 0.3;
          evidence.push("no envelope data and the client-domain address also posts in the project channels");
        } else {
          role = "client";
          roleSource = "email_domain";
          confidence = 0.8;
        }
      } else if (domainIsInternal && !domainIsClient) {
        role = "internal";
        roleSource = "email_domain";
        confidence = 0.8;
      } else if (internalNames.has(key)) {
        role = "internal";
        roleSource = "inferred";
        confidence = 0.65;
      }
    }
    const id = `a_${slugify(key) || `actor_${actors.length + 1}`}${actors.some((entry) => entry.id === `a_${slugify(key)}`) ? `_${actors.length + 1}` : ""}`;
    const model: ReportActorModel = {
      id,
      name: actor.display,
      aliases,
      role,
      roleSource,
      confidence,
      roleEvidence: evidence,
    };
    actors.push(model);
    byName.set(key, model);
  }
  actors.sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  return { actors, byName, byId, resolved };
}

function chooseRepresentative(claims: Claim[], event: Event): Claim | undefined {
  // A2: a claim whose quote was judged not to support it (entailment_refutes)
  // never represents the finding while a cleaner claim exists.
  const refuted = (claim: Claim | undefined): number =>
    claim && NEGATIVE_REFUTE_ERRORS.has(claim.verifyError ?? "") ? 1 : 0;
  return [...claims].sort((a, b) => {
    const refuteRank = refuted(a) - refuted(b);
    if (refuteRank !== 0) return refuteRank;
    const priority = claimTypePriority(a) - claimTypePriority(b);
    if (priority !== 0) return priority;
    const verified = Number(a.verifyStatus === "verified") - Number(b.verifyStatus === "verified");
    if (verified !== 0) return -verified;
    return (a.ts ?? event.ts).localeCompare(b.ts ?? event.ts);
  })[0];
}

/* A2: what a manager may repeat to the client. Cause, fix, promise and
   client-visible status/communication are safe; process, coverage,
   ownership and internal-decision findings are not. */
function clientSafeFor(kind: FindingKind, text: string): boolean {
  if (kind === "technical_finding" || kind === "promise" || kind === "status_change") return true;
  if (kind === "communication") return /\bclient\b/i.test(text);
  return false;
}

function buildClientModel(input: ReportModelInput): ReportClientModel {
  const scope = input.scope;
  // B2: client and project resolve independently. A declared client (manager
  // ground truth) or a verified client-domain anchor makes the client known
  // even when no project string exists; a selected ticket prefix or channel
  // names the project when the model never returned one.
  const clientKnown = Boolean(scope?.client) && scope?.confidence !== "none";
  const scopeUnits = [
    scope?.project ?? null,
    ...(scope?.ticketPrefixes ?? []),
    ...(scope?.channels ?? []),
  ].filter(Boolean) as string[];
  const projectLabel = scopeUnits.length > 0 ? scopeUnits.join(" / ") : null;
  const projectKnown = Boolean(projectLabel);
  const reasons: string[] = [];
  if (!clientKnown) reasons.push("The client is not identified from the escalation or the records.");
  if (!scope?.project && !projectLabel) reasons.push("The project is not identified.");
  if (scope?.confidence === "none") reasons.push("The scope resolved no verified client or project identifiers.");
  return {
    resolved: clientKnown && projectKnown,
    clientKnown,
    projectKnown,
    projectLabel,
    client: scope?.client ?? null,
    project: scope?.project ?? null,
    confidence: scope?.confidence ?? null,
    reviewed: Boolean(scope?.reviewed),
    reasons,
  };
}

function buildAudit(
  findings: ReportFindingModel[],
  notes: SkepticNote[],
  findingByEvent: Map<string, ReportFindingModel>,
  client: ReportClientModel,
): ReportAuditRow[] {
  if (!client.clientKnown) return [];
  const rows: ReportAuditRow[] = [];
  for (const note of notes) {
    if (note.kind !== "contradiction" && note.kind !== "unsupported") continue;
    const eventId = note.eventIds[0];
    const finding = eventId ? findingByEvent.get(eventId) : undefined;
    if (!finding) continue;
    rows.push({
      findingId: finding.id,
      headline: finding.headline,
      note: cleanHumanText(note.text).replace(EMAIL, "a participant"),
    });
  }
  return rows.slice(0, 8);
}

const OPEN_THEMES: { match: RegExp; theme: string; nextStep: string; impact: number }[] = [
  {
    match: /not[- ]searched|never[- ]searched|search log|lookup|query|source lookup|excluded|unsearched|coverage/i,
    theme: "Coverage and evidence",
    nextStep: "Connect the missing source or widen the scope, then re-run the investigation.",
    impact: 5,
  },
  {
    match: /which client|client and project|customer and project|project scope|identif|roster|confirm/i,
    theme: "Client and project",
    nextStep: "Confirm the client and project in the notice above, then re-check the role-dependent cards.",
    impact: 5,
  },
  {
    match: /own(?:er|ed|s)?|assignee|handoff|leave|rota|coverage/i,
    theme: "Ownership and handoff",
    nextStep: "Ask the delivery lead who owned the ticket after the handoff and when it was reassigned.",
    impact: 5,
  },
  {
    match: /technical cause|technical change|root cause|what caused/i,
    theme: "Technical cause",
    nextStep: "Ask the engineer for the failing reproduction or the change that introduced the defect.",
    impact: 4,
  },
  {
    match: /release|deploy|build|version|ship|fix|rollout|cause|root|technical|change/i,
    theme: "Delivery and technical cause",
    nextStep: "Ask the release manager for the deploy log, or the engineer for the failing reproduction.",
    impact: 4,
  },
  {
    match: /reply|respond|told|email|call|chase|unanswered|communica|hear|client/i,
    theme: "Client communication",
    nextStep: "Ask the account manager what the client was told, then search the outbound mailbox.",
    impact: 4,
  },
];

function themeFor(question: string): (typeof OPEN_THEMES)[number] {
  return OPEN_THEMES.find((theme) => theme.match.test(question)) ?? OPEN_THEMES[0];
}

function nextStepFor(_question: string, theme: (typeof OPEN_THEMES)[number]): string {
  return theme.nextStep;
}

function buildOpenQuestions(
  input: ReportModelInput,
  state: ReportStateModel,
  client: ReportClientModel,
  findingByEvent: Map<string, ReportFindingModel>,
  allFindings: ReportFindingModel[],
): OpenQuestionGroup[] {
  const ranked = rankGaps(input.gaps, input.coverage);
  const questions: { question: string; note: string; gapIds: string[]; findingIds: string[]; impact: number }[] =
    ranked.map((gap) => ({
      question: gap.question,
      note: gap.note,
      gapIds: [gap.id],
      findingIds: [...new Set(gap.eventIds.map((eventId) => findingByEvent.get(eventId)?.id).filter((id): id is string => Boolean(id)))],
      impact: gap.tag === "not-searched" ? 5 : gap.tag === "conflicting" ? 4 : gap.rank + 2,
    }));

  const addUnknown = (
    question: string,
    impact: number,
    related: string[] = [],
  ) => {
    const key = question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (questions.some((entry) => entry.question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key)) return;
    questions.push({ question, note: "", gapIds: [], findingIds: related, impact });
  };

  if (!client.clientKnown) {
    addUnknown("Which client and project does this escalation concern?", 5, allFindings.slice(0, 1).map((f) => f.id));
  }
  if (!state.owner.known) {
    addUnknown("Who owned the ticket after the status changed?", 5, state.currentStatus.basis);
  }
  if (!state.latestFix.known) {
    addUnknown("Which change actually fixed the problem?", 4, state.currentStatus.basis.length ? state.currentStatus.basis : allFindings.slice(0, 1).map((f) => f.id));
  }
  if (!state.lastClientContact.known) {
    addUnknown("What did the client hear, and when?", 4, allFindings.slice(-1).map((f) => f.id));
  }
  if (!allFindings.some((finding) => finding.failureTag === "technical" || finding.kind === "technical_finding")) {
    addUnknown("What technical change caused the problem?", 4, state.currentStatus.basis.length ? state.currentStatus.basis : allFindings.slice(0, 1).map((finding) => finding.id));
  }
  const never = input.coverage?.neverSearched ?? [];
  for (const source of never) {
    addUnknown(`Was the answer in ${source}?`, 3, allFindings.slice(0, 1).map((f) => f.id));
  }
  if (never.length === 0 && !client.clientKnown) {
    addUnknown("Were Slack or other channels searched for the missing context?", 3, allFindings.slice(0, 1).map((f) => f.id));
  }

  const groups = new Map<string, OpenQuestionGroup>();
  for (const entry of questions) {
    const theme = themeFor(entry.question);
    const existing = groups.get(theme.theme);
    if (existing) {
      existing.questions.push(entry.question);
      existing.count += 1;
      existing.impact = Math.max(existing.impact, entry.impact);
      existing.gapIds.push(...entry.gapIds);
      existing.findingIds.push(...entry.findingIds);
      continue;
    }
    groups.set(theme.theme, {
      id: `q_${slugify(theme.theme) || groups.size + 1}`,
      theme: theme.theme,
      question: entry.question,
      questions: [entry.question],
      nextStep: nextStepFor(entry.question, theme),
      impact: entry.impact,
      gapIds: [...entry.gapIds],
      findingIds: [...new Set(entry.findingIds)],
      count: 1,
    });
  }

  for (const group of groups.values()) {
    group.findingIds = [...new Set(group.findingIds)];
    group.gapIds = [...new Set(group.gapIds)];
    group.questions = [...new Set(group.questions)];
  }

  return [...groups.values()]
    .sort((a, b) => b.impact - a.impact || a.theme.localeCompare(b.theme))
    .slice(0, 8)
    .map((group, index) => ({ ...group, id: `q_${index + 1}` }));
}

function computeSilence(
  input: ReportModelInput,
): { headline: ReportSilence | null; full: Silences } {
  // C5: the ONE silence computation. The model exposes all three windows and
  // projects the decision-impact headline for the compat field.
  const full = computeSilences({
    events: input.events,
    claims: input.claims,
    commitments: input.commitments,
    gaps: input.gaps,
    notes: input.notes,
    clientEvidence: (input.clientDomains ?? []).length + (input.clientActors ?? []).length > 0
      ? {
          domains: (input.clientDomains ?? []).map((domain) => domain.toLowerCase()),
          actors: input.clientActors ?? [],
          channels: [],
          threads: [],
          eventIds: [],
        }
      : undefined,
  });
  const headline = full.headline
    ? { from: full.headline.from, to: full.headline.to, days: full.headline.days, label: full.headline.label }
    : null;
  return { headline, full };
}

function buildState(
  input: ReportModelInput,
  findings: ReportFindingModel[],
): ReportStateModel {
  // C1: ONE case state. buildCaseState computes what is true now from
  // records only; this adapter projects it into the report's field shape
  // (finding ids for citations, labelled bases, explicit unknown reasons).
  const caseState = buildCaseState({
    events: input.events,
    claims: input.claims,
    commitments: input.commitments,
    gaps: input.gaps,
    notes: input.notes,
    clientDomains: input.clientDomains,
    clientActors: input.clientActors,
  });
  const findingByEvent = new Map<string, ReportFindingModel>();
  for (const finding of findings) for (const eventId of finding.eventIds) findingByEvent.set(eventId, finding);

  const project = <T>(field: { known: boolean; value: T | null; reason?: string | null; since?: string | null; eventId?: string | null; basisLabel?: string | null; basis?: string[] | null }): ReportStateField<T> => {
    if (!field.known) {
      return { known: false, value: null, basis: [], unknownReason: field.reason ?? "Not determined from the records.", basisLabel: null };
    }
    const eventBasis = field.eventId ? findingByEvent.get(field.eventId)?.id ?? field.eventId : null;
    return {
      known: true,
      value: field.value,
      basis: [...(field.basis ?? []), ...(eventBasis ? [eventBasis] : [])].filter(Boolean),
      unknownReason: null,
      basisLabel: field.basisLabel ?? null,
    };
  };

  return {
    asOf: caseState.asOf,
    currentStatus: project(caseState.currentStatus),
    owner: project(caseState.owner),
    statusChangedBy: project(caseState.statusChangedBy),
    lastClientContact: project(caseState.lastClientContact),
    lastInternalUpdate: project(caseState.lastInternalUpdate),
    latestFix: project(caseState.latestFix),
    nextCommitment: project({
      ...caseState.nextCommitment,
      value: caseState.nextCommitment.known
        ? { object: caseState.nextCommitment.value.object, deadline: caseState.nextCommitment.value.deadline }
        : null,
    }) as ReportStateField<{ object: string; deadline: string | null }>,
  };
}

function buildActions(
  findings: ReportFindingModel[],
  state: ReportStateModel,
  actors: ReportActorModel[],
): ReportActionModel[] {
  const actions: ReportActionModel[] = [];
  const isBrokenPromise = (finding: ReportFindingModel): boolean =>
    finding.kind === "promise" && finding.promiseStatus === "broken";
  // The client-facing obligation outranks internal review: a broken promise is
  // the first thing to act on, ahead of conflicts on older findings.
  for (const finding of findings) {
    if (isBrokenPromise(finding)) {
      actions.push({
        id: `act_${actions.length + 1}`,
        text: `Close out the broken promise: ${shortFindingLabel(finding, actors)}.`,
        findingIds: [finding.id],
        tone: "danger",
      });
    }
  }
  for (const finding of findings) {
    if (finding.pill === "conflict" && !isBrokenPromise(finding)) {
      actions.push({
        id: `act_${actions.length + 1}`,
        text: `Resolve the conflict around ${shortFindingLabel(finding, actors)}.`,
        findingIds: [finding.id],
        tone: "danger",
      });
    }
  }
  if (actions.length === 0 && !state.owner.known && state.currentStatus.basis.length > 0) {
    actions.push({
      id: "act_owner",
      text: "Assign an owner: the latest status change names nobody.",
      findingIds: state.currentStatus.basis,
      tone: "warn",
    });
  }
  if (actions.length === 0) {
    actions.push({
      id: "act_none",
      text: "No urgent action found.",
      findingIds: [],
      tone: "neutral",
    });
  }
  return actions.slice(0, 3);
}

function buildHeadline(
  input: ReportModelInput,
  findings: ReportFindingModel[],
  state: ReportStateModel,
  client: ReportClientModel,
  openQuestions: OpenQuestionGroup[],
  counts: ReportCounts,
): ReportHeadline {
  const sources = [...new Set(input.events.map((event) => event.source))];
  const dates = input.events.map((event) => event.ts).sort();
  const stats = [
    `${counts.findings} finding${counts.findings === 1 ? "" : "s"}`,
    `${counts.verified} verified`,
    `${counts.needsCheck} needs check`,
    `${counts.openQuestions} open question${counts.openQuestions === 1 ? "" : "s"}`,
    sources.join(", "),
    dates.length > 0 ? `${dateOnly(dates[0])} – ${dateOnly(dates[dates.length - 1])}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  if (findings.length === 0) {
    return {
      sentences: [
        {
          text: "No records were found for this escalation; a full account is not possible.",
          findingIds: [],
        },
      ],
      statsLine: stats,
      nextStep: "Connect another source or confirm the client.",
      tooThin: true,
    };
  }

  const tooThin = input.events.length < 4;
  const sentences: HeadlineSentence[] = [];
  const day = (iso: string): string =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const kindLabel = (finding: ReportFindingModel): string => {
    switch (finding.kind) {
      case "promise":
        return "a promise";
      case "technical_finding":
        return "a technical finding";
      case "process_failure":
        return "a process failure";
      case "communication":
        return "a client message";
      case "status_change":
        return "a status change";
      default:
        return "a record";
    }
  };
  const statusFinding = findings.find((finding) => finding.kind === "status_change");
  const communicationFinding = findings.find((finding) => finding.kind === "communication");
  const status = statusFinding?.eventText.match(STATUS_TRANSITION);
  const assignee = statusFinding?.eventText.match(ASSIGNEE_TRANSITION);
  const happened: string[] = [];
  if (statusFinding) {
    happened.push(
      assignee
        ? `${assignee[2].trim()} took ownership on ${day(statusFinding.ts)}`
        : status
          ? `the ticket moved to ${status[2].trim()} on ${day(statusFinding.ts)}`
          : `a status change was recorded on ${day(statusFinding.ts)}`,
    );
  } else if (findings[0]) {
    happened.push(`the first record is ${kindLabel(findings[0])} on ${day(findings[0].ts)}`);
  }
  if (communicationFinding) {
    happened.push(`the client followed up on ${day(communicationFinding.ts)}`);
  } else if (findings.length > 1) {
    happened.push(`the latest record is ${kindLabel(findings[findings.length - 1])} on ${day(findings[findings.length - 1].ts)}`);
  }
  const currentState = state.currentStatus.known
    ? `the ticket is ${state.currentStatus.value}`
    : "the current status is not recorded";
  const currentOwner = state.owner.known
    ? `, owned by ${state.owner.value}`
    : " and no owner is recorded";
  const happenedIds = [
    ...new Set(
      [statusFinding?.id, communicationFinding?.id, ...state.currentStatus.basis, ...state.owner.basis].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  const firstIds = happenedIds.length > 0 ? happenedIds : findings.slice(0, 2).map((finding) => finding.id);

  if (tooThin) {
    sentences.push({
      text: `Only ${input.events.length} records were found; a full account is not possible.`,
      findingIds: findings.slice(0, 3).map((finding) => finding.id),
    });
    sentences.push({
      text: `The evidence shows that ${happened.join(", then ")}; the record now shows ${currentState}${currentOwner}.`,
      findingIds: firstIds,
    });
  } else {
    sentences.push({
      text: `The evidence shows that ${happened.join(", then ")}.`,
      findingIds: firstIds,
    });
    sentences.push({
      text: `The record now shows ${currentState}${currentOwner}.`,
      findingIds: firstIds,
    });
  }

  const open = openQuestions[0];
  const unresolvedIds =
    open?.findingIds.length > 0 ? open.findingIds.slice(0, 2) : findings.slice(-1).map((finding) => finding.id);
  sentences.push({
    text: client.clientKnown
      ? open
        ? `What remains open: ${open.theme.toLowerCase()}.`
        : "No open question was recorded; the account is still limited by the available evidence."
      : "The client and project are unresolved, so customer contact and role-based readings cannot be confirmed.",
    findingIds: unresolvedIds.length > 0 ? unresolvedIds : findings.slice(0, 1).map((finding) => finding.id),
  });

  const nextStep = !client.clientKnown
    ? "Confirm the client and project."
    : openQuestions[0]?.theme === "Ownership and handoff"
      ? "Find the owner after the handoff."
      : openQuestions[0]?.theme === "Delivery and technical cause"
        ? "Get the deploy log or a failing reproduction."
        : openQuestions[0]?.theme === "Client communication"
          ? "Ask the account manager for the client thread."
          : openQuestions[0]?.theme === "Coverage and evidence"
            ? "Connect the missing source."
            : "No urgent next step.";

  return {
    sentences: sentences.slice(0, 3),
    statsLine: stats,
    nextStep,
    tooThin,
  };
}

export function buildReportModel(input: ReportModelInput): ReportModel {
  const client = buildClientModel(input);
  const actorInfo = buildActors(input);
  const actorsById = actorInfo.byId;
  const actorIdFor = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    return actorInfo.byName.get(actorKey(raw))?.id ?? null;
  };
  const claimsByEvent = new Map<string, Claim[]>();
  for (const claim of input.claims) {
    if (claim.verifyStatus === "rejected" || claim.review) continue;
    const list = claimsByEvent.get(claim.eventId) ?? [];
    list.push(claim);
    claimsByEvent.set(claim.eventId, list);
  }
  const commitmentByClaim = new Map((input.commitments ?? []).map((commitment) => [commitment.claimId, commitment]));
  const commitmentByEvent = new Map<string, Commitment>();
  for (const commitment of input.commitments ?? []) {
    for (const eventId of commitment.sourceEventIds) commitmentByEvent.set(eventId, commitment);
  }

  const candidateEvents = input.events.filter(
    (event) => claimsByEvent.has(event.id) || isStateRelevant(event) || input.events.length <= 8,
  );
  const drafts: ReportFindingModel[] = [];
  for (const event of candidateEvents) {
    const claims = claimsByEvent.get(event.id) ?? [];
    const representative = chooseRepresentative(claims, event);
    const commitment = representative ? commitmentByClaim.get(representative.id) : commitmentByEvent.get(event.id);
    const rawText = representative?.text ?? event.text;
    const eventActorId = actorIdFor(event.actorResolved ?? event.actor);
    const claimActorId = actorIdFor(representative?.actor ?? null);
    const actorIds = [...new Set([eventActorId, claimActorId].filter((id): id is string => Boolean(id)))];
    // A commitment-typed finding is only a promise when its text actually
    // promises something: closure and status statements ("told X that T was
    // resolved", "was reported fixed") are communications, not promises
    // (G-05). Structured commitments passed this guard at submission time.
    const isPromiseFinding =
      Boolean(commitment) ||
      (representative?.type === "commitment" &&
        isPromiseLike(representative.text, representative.text));
    let kind = kindFor(event, representative);
    if (kind === "promise" && !isPromiseFinding) kind = "communication";
    const status = event.text.match(STATUS_TRANSITION);
    const assignee = event.text.match(ASSIGNEE_TRANSITION);
    const actorName = actorIds.length > 0 ? actorsById.get(actorIds[0])?.name ?? null : null;
    const { state: verification, incompatible } = representativeVerification(claims);
    const conflict =
      incompatible ||
      claims.some((claim) => claim.skepticFlag) ||
      Boolean(commitment?.contested) ||
      input.notes.some(
        (note) =>
          note.kind === "contradiction" &&
          (note.eventIds.includes(event.id) || (representative && note.claimId === representative.id)),
      );
    const flags: FindingFlag[] = [];
    if (conflict) flags.push("conflict");
    if (verification !== "verified" && !conflict) flags.push("needs_check");
    // A2: a refuted representative is never a verified fact — label it.
    const representativeRefuted =
      Boolean(representative && NEGATIVE_REFUTE_ERRORS.has(representative.verifyError ?? ""));
    if (representativeRefuted) flags.push("needs_check");
    const pill = conflict ? "conflict" : verification === "verified" ? null : "needs_check";
    const importance: FindingImportance =
      kind === "process_failure" || kind === "technical_finding" || conflict || (kind === "promise" && commitment?.status === "broken")
        ? "key"
        : kind === "status_change" || kind === "promise" || kind === "communication"
          ? "normal"
          : "routine";
    const statusText = status
      ? `The ${event.channel} ticket moved from ${status[1].trim()} to ${status[2].trim()}.`
      : assignee
        ? `${assignee[2].trim()} took ownership of ${event.channel}.`
        : rawText;
    const text = stripEmailText(cleanHumanText(kind === "status_change" ? statusText : rawText), actorInfo.actors);
    const headline = headlineFor(kind, event, text, actorName, status?.[2], assignee?.[2]);
    drafts.push({
      id: "",
      slug: "",
      kind,
      headline,
      text,
      eventText: event.text,
      actorIds,
      eventActorId,
      ts: event.ts,
      source: event.source,
      channel: event.channel,
      issueId: representative?.issueId ?? null,
      claimIds: claims.map((claim) => claim.id),
      quotes: [...new Set(claims.map((claim) => claim.quote).filter(Boolean))],
      eventIds: [event.id],
      verification,
      importance,
      flags,
      pill,
      failureTag: failureTagFor(kind, text),
      promiseStatus: isPromiseFinding ? promiseStatusFor(representative, commitment) : null,
      deadline: commitment?.deadlinePhrase ?? null,
      clientSafe: clientSafeFor(kind, text),
      sourceCount: 1,
    });
  }

  // Same commitment stated in several records is one finding.
  const merged: ReportFindingModel[] = [];
  const commitGroups = new Map<string, ReportFindingModel[]>();
  for (const draft of drafts) {
    const commitment =
      draft.claimIds.map((claimId) => commitmentByClaim.get(claimId)).find(Boolean) ??
      draft.eventIds.map((eventId) => commitmentByEvent.get(eventId)).find(Boolean);
    if (!commitment) {
      merged.push(draft);
      continue;
    }
    const group = commitGroups.get(commitment.id) ?? [];
    group.push(draft);
    commitGroups.set(commitment.id, group);
  }
  for (const [commitmentId, group] of commitGroups) {
    const commitment = (input.commitments ?? []).find((entry) => entry.id === commitmentId);
    const representative =
      group.find((entry) => commitment && entry.claimIds.includes(commitment.claimId)) ?? group[0];
    const ts = group.map((entry) => entry.ts).sort()[0] ?? representative.ts;
    const eventIds = [...new Set(group.flatMap((entry) => entry.eventIds))];
    const claimIds = [...new Set(group.flatMap((entry) => entry.claimIds))];
    const quotes = [...new Set(group.flatMap((entry) => entry.quotes))];
    const actorIds = [...new Set(group.flatMap((entry) => entry.actorIds))];
    const conflict = group.some((entry) => entry.flags.includes("conflict")) || Boolean(commitment?.contested);
    // A1: the strongest state survives; restatements never downgrade.
    const verification = group
      .map((entry) => entry.verification)
      .reduce((best, current) => (CLAIM_STATE_RANK[current] > CLAIM_STATE_RANK[best] ? current : best), "unverified" as FindingVerification);
    merged.push({
      ...representative,
      ts,
      eventIds,
      claimIds,
      quotes,
      actorIds,
      verification,
      flags: conflict ? ["conflict"] : verification === "verified" ? [] : ["needs_check"],
      pill: conflict ? "conflict" : verification === "verified" ? null : "needs_check",
      sourceCount: eventIds.length,
      promiseStatus: commitment?.status === "withdrawn" ? "unclear" : commitment?.status ?? representative.promiseStatus,
    });
  }

  // Near-identical claims across records: same ticket/actor and high text
  // similarity become one finding. Keep every claim id.
  const deduped: ReportFindingModel[] = [];
  for (const finding of merged) {
    const target = deduped.find((candidate) => {
      const sharedActor = candidate.actorIds.some((id) => finding.actorIds.includes(id));
      const timeGap = Math.abs(Date.parse(candidate.ts) - Date.parse(finding.ts));
      const textSimilarity = similarity(candidate.text, finding.text);
      const quoteSimilarity =
        Math.max(
          0,
          ...candidate.quotes.flatMap((left) => finding.quotes.map((right) => similarity(left, right))),
        );
      const candidateTickets = ticketRefs(candidate.text, ...candidate.quotes);
      const findingTickets = ticketRefs(finding.text, ...finding.quotes);
      const sharedTicket = [...candidateTickets].some((ticket) => findingTickets.has(ticket));
      const bothQuoted = candidate.quotes.length > 0 && finding.quotes.length > 0;
      const similar =
        textSimilarity >= 0.55 ||
        // Identical quotes alone must not merge textually unrelated findings:
        // the texts still have to overlap for this to be one restatement.
        (bothQuoted && quoteSimilarity >= 0.5 && textSimilarity >= 0.25) ||
        (bothQuoted && sharedTicket && quoteSimilarity >= 0.45);
      // Same person restating the same point in Jira and Slack within a short
      // window is one finding; quote/ticket overlap is the disambiguator when
      // the agent's paraphrases differ ("confirmed" vs "assessed as likely").
      return sharedActor && timeGap <= 3 * 86_400_000 && similar;
    });
    if (!target) {
      deduped.push({ ...finding });
      continue;
    }
    const earlier = finding.ts < target.ts;
    const eventIds = [...new Set([...target.eventIds, ...finding.eventIds])];
    target.eventIds = eventIds;
    target.claimIds = [...new Set([...target.claimIds, ...finding.claimIds])];
    target.quotes = earlier
      ? [...new Set([...finding.quotes, ...target.quotes])]
      : [...new Set([...target.quotes, ...finding.quotes])];
    target.actorIds = [...new Set([...target.actorIds, ...finding.actorIds])];
    target.sourceCount = eventIds.length;
    if (earlier) {
      // Keep the earliest wording, not a later restatement that may sound
      // more certain ("confirmed" vs the source's "looks like").
      target.ts = finding.ts;
      target.text = finding.text;
      target.headline = finding.headline;
      target.source = finding.source;
      target.channel = finding.channel;
      target.eventActorId = finding.eventActorId;
      target.issueId = finding.issueId;
      target.kind = finding.kind;
      target.failureTag = finding.failureTag;
      target.importance =
        target.importance === "key" || finding.importance === "key"
          ? "key"
          : target.importance === "normal" || finding.importance === "normal"
            ? "normal"
            : "routine";
    } else {
      target.ts = target.ts;
    }
    // A1: the strongest state survives the merge; a supported restatement
    // never downgrades a verified representative.
    target.verification =
      CLAIM_STATE_RANK[finding.verification] > CLAIM_STATE_RANK[target.verification]
        ? finding.verification
        : target.verification;
    const mergedConflict =
      finding.flags.includes("conflict") || target.flags.includes("conflict");
    target.pill =
      mergedConflict
        ? "conflict"
        : target.verification === "verified"
          ? null
          : "needs_check";
    target.flags =
      target.pill === "conflict"
        ? ["conflict"]
        : target.verification === "verified"
          ? []
          : ["needs_check"];
  }

  const sorted = deduped.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  sorted.forEach((finding, index) => {
    finding.id = `f${index + 1}`;
    finding.slug = `finding-${finding.id}`;
  });

  const findingByEvent = new Map<string, ReportFindingModel>();
  for (const finding of sorted) for (const eventId of finding.eventIds) findingByEvent.set(eventId, finding);

  const state = buildState(input, sorted);
  const openQuestions = buildOpenQuestions(input, state, client, findingByEvent, sorted);
  const questionCounts: QuestionCounts = {
    groups: openQuestions.length,
    raw: openQuestions.reduce((total, group) => total + Math.max(group.questions.length, 1), 0),
  };
  const promises = sorted.filter((finding) => finding.kind === "promise" || finding.promiseStatus !== null);
  const failures = sorted.filter((finding) => finding.failureTag !== null);
  // A2: "You can say" = verified AND client-safe AND unflagged. The count
  // and the list are one value.
  const verifiedFindings = sorted.filter(
    (finding) => finding.verification === "verified" && finding.pill === null && finding.clientSafe,
  );
  const withheldVerified = sorted.filter((finding) => finding.verification === "verified" && finding.pill !== null);
  const flagged = sorted.filter((finding) => finding.pill !== null);
  const counts: ReportCounts = {
    findings: sorted.length,
    verified: verifiedFindings.length,
    needsCheck: flagged.length,
    openQuestions: openQuestions.length,
  };

  // Server-side assertions: a header number that does not equal the list it
  // summarizes must stop the report rather than ship a contradiction.
  if (counts.findings !== sorted.length) throw new Error("Report model count mismatch: findings");
  if (counts.verified !== verifiedFindings.length) {
    throw new Error("Report model count mismatch: verified");
  }
  if (counts.needsCheck !== sorted.filter((finding) => finding.pill !== null).length) {
    throw new Error("Report model count mismatch: needs check");
  }
  if (counts.openQuestions !== openQuestions.length) {
    throw new Error("Report model count mismatch: open questions");
  }

  const headline = buildHeadline(input, sorted, state, client, openQuestions, counts);
  const actions = buildActions(sorted, state, actorInfo.actors);
  const suppressPills = sorted.length > 0 && flagged.length / sorted.length > 0.6;
  const pillSummary = suppressPills
    ? `Needs check: ${flagged.length} of ${sorted.length}${flagged.some((finding) => finding.pill === "conflict") ? " (including conflicts)" : ""} — the supporting records are thin.`
    : null;
  const clientEvidence: ClientEvidenceInput = {
    domains: (input.clientDomains ?? []).map((domain) => domain.toLowerCase()),
    actors: input.clientActors ?? [],
    channels: [],
    threads: [],
    eventIds: [],
  };
  const contradictions = detectContradictions({
    events: input.events,
    claims: input.claims,
    promises: input.commitments ?? [],
    asOf: state.asOf,
    clientEvidence: client.clientKnown ? clientEvidence : undefined,
  });
  const audit = [
    ...contradictions.map((contradiction) => ({
      findingId: contradiction.basis[0] ? findingByEvent.get(contradiction.basis[0])?.id ?? contradiction.basis[0] : "",
      headline: contradiction.detector.replace(/_/g, " "),
      note: contradiction.managerText,
    })),
    ...buildAudit(sorted, input.notes, findingByEvent, client),
  ].slice(0, 12);
  const processFailures = failures.filter((finding) => finding.failureTag === "process").length;
  const processNormsNote =
    processFailures > 0
      ? "Process failures are judged against generic norms; no client SLA is recorded for this project."
      : null;

  const silence = computeSilence(input);

  return {
    title: cleanReportTitle(input.investigation.title),
    client,
    actors: actorInfo.actors,
    findings: sorted,
    promises,
    failures,
    state,
    counts,
    questionCounts,
    contradictions,
    headline,
    verifiedFindings,
    withheldVerified,
    actions,
    openQuestions,
    silence: silence.headline,
    silences: silence.full,
    audit,
    suppressPills,
    pillSummary,
    processNormsNote,
  };
}

export function shortFindingLabel(finding: ReportFindingModel, actors: ReportActorModel[]): string {
  return shortLabelFor(finding, actors);
}

/* The label before any word cap: the drawer shows this as its bold first line,
   so "see more" reveals exactly the sentence that was truncated. */
export function fullFindingLabel(finding: ReportFindingModel, actors: ReportActorModel[]): string {
  return labelFor(finding, actors, true);
}

export type { GapTag };
