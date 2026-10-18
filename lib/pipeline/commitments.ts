import type { CommitmentStatus } from "../types";
import { decodeEntities } from "../ingest/entities";

/* G-05: promise identity and outcome rules live in code, not in the model.
   The agent supplies structure (promisor, object, deadline phrase, status);
   these functions decide the key, the merge and the final outcome. */

/** Words that differ between restatements of the same promise. */
const OBJECT_STOPWORDS = new Set([
  "the", "a", "an", "to", "in", "on", "of", "for", "by", "and", "or", "will",
  "would", "we", "i", "he", "she", "they", "it", "this", "that", "is", "are",
  "be", "been", "have", "has", "had", "with", "as", "at", "from", "our",
  "their", "his", "her", "will", "shall", "should", "get", "got", "make",
  "made", "ship", "shipped", "release", "released", "deliver", "delivered",
  "fix", "fixed", "next", "again",
]);

/** Strip dates and filler so the same promise keys the same in any wording.
    HTML entities are decoded first: Jira exports store "&lt;l.chen@…&gt;" and
    the entity text must never split one promisor into two (I5). */
export function normalizeObject(object: string): string {
  return decodeEntities(object)
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{0,2}(?:st|nd|rd|th)?\b/g,
      " ",
    )
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !OBJECT_STOPWORDS.has(word))
    .sort()
    .join(" ")
    .trim();
}

/** Identity-normalised person key: email suffix, punctuation and word order
    must not split one promisor into two people. Entities decoded first (I5). */
export function normalizePerson(person: string | null): string {
  if (!person) return "";
  return decodeEntities(person)
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** Same promisor + object + deadline = one promise. The promisee's wording
    ("Northwind", "Priya Nair / Meridian (Northwind)") differs between
    restatements of the same promise, so it must not split the key. */
export function commitmentDedupeKey(input: {
  promisor: string | null;
  promisee: string | null;
  object: string;
  deadlineIso: string | null;
}): string {
  const deadline = input.deadlineIso ? input.deadlineIso.slice(0, 10) : "no-deadline";
  return [
    normalizePerson(input.promisor),
    normalizeObject(input.object),
    deadline,
  ].join("|");
}

/* G-05/C2: a QA report, a "resolved" assertion, a completed-fix report, a
   client confirmation and a decision ("keep it open") are not promises. The
   promise needs an explicit forward-looking statement (will/commit/schedule/
   promise/intend/due) — shipping or merely naming a release is a status
   report, and "keep .* open" is a decision about the process. */
const PROMISE_CUE =
  /\b(will|shall|commit(?:ted|s|ment)?|promis(?:e|ed|es)|schedul(?:ed|e|ing)?|target(?:ed|s|ing)?|ship|deliver|due|by (?:the )?[\w.-]+ release|tomorrow|next release|plan(?:ned|s)?|intend(?:ed|s)?|should)\b/i;
const COMPLETED_CUE =
  /\b(?:was|were|is|are|has been|have been)\s+(?:fixed|resolved|completed|verified|corrected|closed|delivered|shipped)\b|\b(?:fixed|resolved|completed|verified|corrected|closed|delivered|shipped)\s+(?:by|in|with)\b|\bshipped\b|\bdelivered\b/i;
const FORWARD_STEM = /\b(?:will|shall|commit|promis|schedul|target|tomorrow|next release|plan|intend)/i;
const DUE_WORD = /\bdue\b/i;

function hasForwardCue(combined: string): boolean {
  return FORWARD_STEM.test(combined) || DUE_WORD.test(combined);
}

export function isPromiseLike(object: string, claimText = ""): boolean {
  const combined = `${object} ${claimText}`;
  if (!PROMISE_CUE.test(combined)) return false;
  // A past-tense completion statement is not a promise unless it also says
  // when the still-pending work will happen.
  if (COMPLETED_CUE.test(object) && !hasForwardCue(object)) return false;
  // C2: a decision or a status assertion carries no forward-looking cue.
  // "Keep it open until QA passes" and "the release is cut; fix included"
  // name no pending work and are not promises.
  if (!hasForwardCue(combined)) return false;
  return true;
}

const OUTCOME_WEIGHT: Record<CommitmentStatus, number> = {
  broken: 0,
  withdrawn: 1,
  unclear: 2,
  kept: 3,
};

export interface MergedStatus {
  status: CommitmentStatus;
  contested: boolean;
  rationale: string | null;
}

/** A failing outcome outweighs a "kept" reading; disagreement is contested. */
export function mergeStatuses(statuses: CommitmentStatus[], rationale: string | null): MergedStatus {
  const distinct = [...new Set(statuses)];
  if (distinct.length <= 1) {
    const status = distinct[0] ?? "unclear";
    return { status, contested: false, rationale };
  }
  const sorted = [...distinct].sort((a, b) => OUTCOME_WEIGHT[a] - OUTCOME_WEIGHT[b]);
  return {
    status: sorted[0],
    contested: true,
    rationale: `sources disagree on the outcome (${distinct.join(" vs ")})${rationale ? ` — ${rationale}` : ""}`,
  };
}

/** kept requires evidence of delivery; otherwise the outcome is unclear. */
export function applyStatusRules(input: {
  status: CommitmentStatus;
  fulfilmentEventIds: string[];
  rationale: string | null;
}): MergedStatus {
  if (input.status === "kept" && input.fulfilmentEventIds.length === 0) {
    return {
      status: "unclear",
      contested: false,
      rationale: "marked kept without a record of delivery — outcome unclear",
    };
  }
  return { status: input.status, contested: false, rationale: input.rationale };
}
