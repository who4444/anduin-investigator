export type SourceKind = "jira" | "email" | "slack";

export type StageName =
  | "ingest"
  | "plan"
  | "root_cause"
  | "commitments"
  | "ownership"
  | "skeptic"
  | "verify"
  | "assemble";

export type StageStatus = "pending" | "running" | "done" | "error";

export type ClaimStatus = "kept" | "broken" | "unclear" | "n/a";

export type VerifyStatus = "verified" | "supported" | "rejected" | "unverified";

export type EntailmentVerdict = "supports" | "partial" | "refutes" | "unavailable";

export interface ClaimQuoteCheck {
  ok: boolean;
  error?: string;
}

export interface ClaimAttributionCheck {
  ok: boolean;
  reason?: string;
  claimActor: string | null;
  eventActor: string;
  claimTs: string | null;
  eventTs: string;
}

export interface ClaimEntailmentCheck {
  verdict: EntailmentVerdict;
  error?: string;
}

/** G-03: the search-completeness proof a negative claim carries. */
export interface ClaimNegativeCheck {
  subject: string | null;
  complete: boolean;
  basis: string;
  failedQueries: number;
  notSearched: string[];
  excludedClientRecords: number;
}

export interface ClaimChecks {
  quote?: ClaimQuoteCheck | null;
  attribution?: ClaimAttributionCheck | null;
  entailment?: ClaimEntailmentCheck | null;
  negative?: ClaimNegativeCheck | null;
}

export type SkepticNoteKind = "contradiction" | "unsupported" | "silence" | "unanswered";

export interface EventInput {
  source: SourceKind;
  ts: string;
  actor: string;
  channel: string;
  text: string;
  url?: string;
  threadId?: string;
  refs?: string[];
  meta?: Record<string, unknown>;
}

export interface Event extends EventInput {
  id: string;
  investigationId: string;
  actorResolved?: string | null;
}

export interface ClaimInput {
  agent: string;
  type: string;
  text: string;
  actor?: string;
  quote: string;
  eventId: string;
  ts?: string;
  status: ClaimStatus;
  confidence: number;
  /** Which independent issue this finding belongs to (G-23). */
  issueId?: string | null;
}

export interface Claim extends ClaimInput {
  id: string;
  investigationId: string;
  verifyStatus: VerifyStatus;
  verifyError?: string | null;
  checks?: ClaimChecks;
  skepticFlag: boolean;
  /** G-14: the manager's correction, when they reviewed this claim. */
  review?: ClaimReview | null;
}

export type ClaimReviewVerdict = "wrong" | "unsupported" | "out_of_scope";

export interface ClaimReview {
  claimId: string;
  verdict: ClaimReviewVerdict;
  reason: string | null;
  createdAt: string;
}

/** What a live pull actually searched: the expanded targets with labels, for
    the "I'll search: …" scope review. Null for upload/demo runs. */
export interface SourceSelectionEntry {
  source: string;
  targets: { id: string; label: string }[];
  query: string | null;
}

export interface Investigation {
  id: string;
  title: string;
  escalationText: string;
  status: string;
  contentHash: string;
  plan: string | null;
  createdAt: string;
  scope: InvestigationScope | null;
  declaredClient: string | null;
  sourceSelection: SourceSelectionEntry[] | null;
  /** Registry record ids the manager added back from the excluded list (G-01). */
  scopeOverrides: string[];
  /** When the pre-run scope review was confirmed (G-12). */
  scopeReviewedAt: string | null;
  planData: PlanData | null;
  ingestWarnings: string[];
  origin: string;
}

export interface Stage {
  stage: StageName;
  pass: number;
  status: StageStatus;
  error?: string | null;
  log: unknown[];
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface IdentityResolution {
  id: string;
  investigationId: string;
  alias: string;
  canonical: string;
  method: string;
  confidence: number;
  applied: boolean;
}

export interface IdentityResolutionInput {
  alias: string;
  canonical: string;
  method: string;
  confidence: number;
  applied: boolean;
}

export interface SkepticNoteInput {
  claimId?: string;
  kind: SkepticNoteKind;
  text: string;
  eventIds: string[];
}

export interface SkepticNote {
  id: string;
  investigationId: string;
  claimId?: string;
  kind: SkepticNoteKind;
  text: string;
  eventIds: string[];
}

export type GapCategory =
  | "scope"
  | "coverage"
  | "state"
  | "technical"
  | "commitment"
  | "communication"
  | "ownership"
  | "other";

export interface GapInput {
  question: string;
  note: string;
  eventIds: string[];
  issueId?: string | null;
  /** C6: the structured category, set at write time — never a text regex. */
  category?: GapCategory | null;
}

export interface Gap {
  id: string;
  investigationId: string;
  question: string;
  note: string;
  eventIds: string[];
  issueId?: string | null;
  category?: GapCategory | null;
}

export type InvestigationOrigin = "upload" | "pull" | "demo";

export interface NewInvestigation {
  title: string;
  escalationText: string;
  contentHash: string;
  declaredClient?: string | null;
  origin?: InvestigationOrigin;
}

export type ScopeConfidence = "scoped" | "partial" | "none";

export type ScopeAnchorKind = "declared-client" | "ticket-prefix" | "channel" | "sender-domain";

export type ScopeAnchorSource = "declared" | "escalation" | "learned" | "linked" | "model";

export interface ScopeAnchor {
  kind: ScopeAnchorKind;
  value: string;
  source: ScopeAnchorSource;
}

export interface InvestigationScope {
  client: string | null;
  project: string | null;
  ticketPrefixes: string[];
  channels: string[];
  senderDomains: string[];
  confidence: ScopeConfidence;
  anchors: ScopeAnchor[];
}

export interface PlanHypothesis {
  statement: string;
  test: string;
  falsify: string;
}

export interface PlanSource {
  source: string;
  approach: string;
}

export interface PlanDateWindow {
  from: string | null;
  to: string | null;
}

export interface PlanIssue {
  title: string;
  ask: string;
  summary: string;
  confidence: number;
}

export interface PlanData {
  framing: string;
  hypotheses: PlanHypothesis[];
  sources: PlanSource[];
  searchTerms: string[];
  people: string[];
  dateWindow: PlanDateWindow;
  unknowns: string[];
  issues: PlanIssue[];
  /** Independent issues the model detected beyond the cap (3). */
  issueOverflow: number;
}

/** One investigation can contain up to three independent issues (G-23). */
export interface Issue {
  id: string;
  investigationId: string;
  seq: number;
  title: string;
  ask: string;
  summary: string;
  confidence: number;
  confirmed: boolean;
  createdAt: string;
}

export interface IssueInput {
  id?: string;
  title: string;
  ask: string;
  summary: string;
  confidence: number;
}

/** G-05: a promise as a first-class entity, backed by one verified claim. */
export type CommitmentStatus = "kept" | "broken" | "unclear" | "withdrawn";

export interface CommitmentInput {
  claimId: string;
  issueId?: string | null;
  promisor: string | null;
  promisee: string | null;
  /** What exactly was promised, in one phrase ("invoice totals corrected"). */
  object: string;
  conditions: string | null;
  /** The deadline as stated in the record ("Sep 24"). */
  deadlinePhrase: string | null;
  /** Resolved by CODE from the phrase and the record's timestamp. */
  deadlineIso: string | null;
  rationale: string | null;
  /** Records that evidence the object was delivered (kept requires these). */
  fulfilmentEventIds: string[];
}

export interface Commitment extends CommitmentInput {
  id: string;
  investigationId: string;
  status: CommitmentStatus;
  /** Sources disagreed on the outcome; one row carries the contested state. */
  contested: boolean;
  /** Event ids of every source record that states this promise. */
  sourceEventIds: string[];
  dedupeKey: string;
  createdAt: string;
}

export type ReplyLabel = "safe" | "needs-check" | "do-not-send";

export interface ReplySentence {
  text: string;
  claimIds: string[];
  label?: ReplyLabel;
}

export interface ReplyPayload {
  greeting?: string;
  sentences: ReplySentence[];
  signOff?: string;
  approved?: boolean;
}
