import type { InvestigatorKind } from "../agents/investigator";
import type { CoverageReport } from "./coverage";
import type {
  Claim,
  Commitment,
  Gap,
  GapCategory,
  Investigation,
  SourceKind,
  SkepticNote,
} from "../types";

/* I3: gap-driven retry. The old retry fired only when an investigator kind had
   zero visible claims; every kind shipped claims even when a decision-relevant
   angle was missed. This computes DETERMINISTIC retry reasons — no LLM calls —
   from the plan hypotheses, the coverage states, the skeptic's unanswered notes
   and the question groups that have no supporting fact. Each reason names the
   investigator kind(s) to rerun and the explicit query to record in the stage
   log. */

export type RetryReasonKind =
  | "missing_kind"
  | "hypothesis"
  | "unsearched_source"
  | "unanswered"
  | "question_group"
  | "empty_ledger";

export interface RetryReason {
  kind: RetryReasonKind;
  /** Investigator kinds this reason targets. */
  kinds: InvestigatorKind[];
  /** Short "retried for …" line for the stage log. */
  reason: string;
  /** The explicit query the retry investigator must run, when one applies. */
  query: string | null;
  /** Event ids the reason is grounded in (empty for a plan hypothesis). */
  basis: string[];
}

export interface RetryPlan {
  needsRetry: boolean;
  reasons: RetryReason[];
  /** Unique targeted kinds, in canonical order and never empty of duplicates. */
  kinds: InvestigatorKind[];
}

export interface RetryInput {
  investigation: Investigation;
  /** Scoped claims, including rejected ones (visibility is computed here). */
  claims: Claim[];
  coverage: CoverageReport;
  notes: SkepticNote[];
  gaps: Gap[];
  /** Every record id the registry holds; an unanswered note must cite one. */
  registryIds: Set<string>;
  /** Investigator kinds with zero visible claims (the old retry trigger). */
  missing: InvestigatorKind[];
  pass: number;
  maxPass?: number;
  /** I3: the canonical ledger — an empty ledger behind investigated promises
      is a gap-driven retry reason. */
  commitments?: Commitment[];
}

const KINDS: InvestigatorKind[] = ["root_cause", "commitments", "ownership"];

const STOPWORDS = new Set([
  "the", "and", "for", "was", "were", "are", "that", "this", "with", "from", "into",
  "after", "before", "when", "where", "which", "what", "who", "whom", "whose", "why",
  "how", "not", "but", "had", "has", "have", "been", "its", "their", "they", "them",
  "then", "than", "over", "under", "about", "would", "could", "should", "will", "can",
  "may", "might", "must", "did", "does", "done", "is", "be", "of", "to", "in", "on",
  "at", "as", "or", "an", "it", "by", "if", "no", "so", "up", "out", "per", "via",
  "any", "all", "each", "same", "also", "more", "most", "other", "some", "such",
]);

const TICKET_REF = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

const SOURCE_QUERY: Record<SourceKind, string> = {
  jira: "search_jira(all)",
  slack: "search_slack(all)",
  email: "search_email(all)",
};

const SOURCE_KIND: Record<SourceKind, InvestigatorKind> = {
  jira: "root_cause",
  slack: "ownership",
  email: "commitments",
};

const CATEGORY_KIND: Record<GapCategory, InvestigatorKind> = {
  scope: "ownership",
  coverage: "ownership",
  state: "ownership",
  technical: "root_cause",
  commitment: "commitments",
  communication: "ownership",
  ownership: "ownership",
  other: "ownership",
};

const KIND_LABEL: Record<InvestigatorKind, string> = {
  root_cause: "root cause",
  commitments: "commitments",
  ownership: "ownership",
};

function isVisible(claim: Claim): boolean {
  return claim.verifyStatus === "verified" || claim.verifyStatus === "supported";
}

/** Significant terms shared between a hypothesis and the claim coverage. */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 4 && !STOPWORDS.has(term));
}

/** The investigator whose mission a piece of text most closely matches. */
function kindForText(text: string): InvestigatorKind {
  if (/\b(?:promis\w*|commit\w*|deadline|owed|agreed date|schedul\w*|target(?:ed|ing)?|by when)\b/i.test(text)) {
    return "commitments";
  }
  if (
    /\b(?:owner\w*|handoff|hand-off|decid\w*|decision|escalat\w*|assign\w*|unanswered|process failure|leave|hand over)\b/i.test(
      text,
    )
  ) {
    return "ownership";
  }
  return "root_cause";
}

function hypothesisQuery(statement: string, test: string): string {
  const refs = `${statement} ${test}`.match(TICKET_REF);
  if (refs && refs.length > 0) return refs.map((ref) => `get_issue(${ref})`).join(", ");
  return test.trim() || statement.trim();
}

function firstSentence(text: string, maxChars = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

export function deriveRetryPlan(input: RetryInput): RetryPlan {
  const maxPass = input.maxPass ?? 2;
  const visible = input.claims.filter(isVisible);
  const claimText = visible
    .map((claim) => `${claim.text} ${claim.quote}`)
    .join("\n")
    .toLowerCase();
  const visibleEventIds = new Set(visible.map((claim) => claim.eventId));
  const reasons: RetryReason[] = [];

  for (const kind of input.missing) {
    reasons.push({
      kind: "missing_kind",
      kinds: [kind],
      reason: `no visible finding from the ${KIND_LABEL[kind]} investigator`,
      query: null,
      basis: [],
    });
  }

  // I3: the commitments investigator reported findings but the promise ledger
  // is empty — the promises were seen but never recorded as promises. Retry
  // the commitments kind with an explicit promise-search query.
  const commitmentsClaims = visible.filter((claim) => claim.agent === "commitments");
  const ledgerRows = (input.commitments ?? []).filter(
    (commitment) =>
      commitment.status !== "withdrawn" &&
      commitment.claimId &&
      visible.some((claim) => claim.id === commitment.claimId || claim.eventId === commitment.sourceEventIds[0]),
  );
  if (commitmentsClaims.length > 0 && ledgerRows.length === 0) {
    reasons.push({
      kind: "empty_ledger",
      kinds: ["commitments"],
      reason: "the commitments investigator reported findings but the promise ledger is empty — promises were seen but not recorded as promises",
      query: "search_email(promise) — record every promise with submit_commitment (promisor, object, deadline)",
      basis: [],
    });
  }

  for (const hypothesis of input.investigation.planData?.hypotheses ?? []) {
    const hypothesisTerms = terms(hypothesis.statement);
    if (hypothesisTerms.length === 0) continue;
    const covered = hypothesisTerms.some((term) => claimText.includes(term));
    if (covered) continue;
    reasons.push({
      kind: "hypothesis",
      kinds: [kindForText(`${hypothesis.statement} ${hypothesis.test}`)],
      reason: `a plan hypothesis has no supporting finding: ${firstSentence(hypothesis.statement)}`,
      query: hypothesisQuery(hypothesis.statement, hypothesis.test),
      basis: [],
    });
  }

  for (const source of input.coverage.neverSearched) {
    const entry = input.coverage.sources.find((candidate) => candidate.source === source);
    if (!entry || entry.state !== "available-not-searched") continue;
    reasons.push({
      kind: "unsearched_source",
      kinds: [SOURCE_KIND[source]],
      reason: `the ${source} source was available but never searched`,
      query: SOURCE_QUERY[source],
      basis: [],
    });
  }

  for (const note of input.notes) {
    if (note.kind !== "unanswered") continue;
    const basis = note.eventIds.filter((eventId) => input.registryIds.has(eventId));
    if (basis.length === 0) continue;
    reasons.push({
      kind: "unanswered",
      kinds: [kindForText(note.text)],
      reason: `an unanswered question the records can answer: ${firstSentence(note.text)}`,
      query: note.text.trim(),
      basis,
    });
  }

  const byCategory = new Map<GapCategory, Gap[]>();
  for (const gap of input.gaps) {
    const category = gap.category ?? "other";
    const list = byCategory.get(category) ?? [];
    list.push(gap);
    byCategory.set(category, list);
  }
  for (const [category, gaps] of byCategory) {
    const cited = gaps.flatMap((gap) => gap.eventIds);
    // A group with no cited records is not grounded; one with a supporting
    // visible fact is already answered.
    if (cited.length === 0 || cited.some((eventId) => visibleEventIds.has(eventId))) continue;
    reasons.push({
      kind: "question_group",
      kinds: [CATEGORY_KIND[category]],
      reason: `the ${category} question group has no supporting finding`,
      query: gaps[0].question.trim(),
      basis: [...new Set(cited)],
    });
  }

  const targeted = new Set<InvestigatorKind>();
  for (const reason of reasons) {
    for (const kind of reason.kinds) targeted.add(kind);
  }

  return {
    needsRetry: reasons.length > 0 && input.pass < maxPass,
    reasons,
    kinds: KINDS.filter((kind) => targeted.has(kind)),
  };
}
