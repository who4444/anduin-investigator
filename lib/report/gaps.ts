import type { Gap } from "../types";
import type { CoverageReport } from "../pipeline/coverage";

/* G-11: gaps ranked by decision impact, deduped, tagged, and cleaned of
   agent voice and raw record ids. The manager reads a queue, not a wall. */

export type GapTag = "not-searched" | "conflicting" | "searched-absent" | "open";

export interface RankedGap {
  id: string;
  question: string;
  note: string;
  tag: GapTag;
  /** Higher sorts first; ties keep source order. */
  rank: number;
  eventIds: string[];
}

export const GAP_TAG_LABEL: Record<GapTag, string> = {
  "not-searched": "not searched",
  conflicting: "records conflict",
  "searched-absent": "searched, nothing found",
  open: "open question",
};

/* Words that tie a gap to the client-facing decision, not to internal trivia. */
const CLIENT_TALK = /\b(client|customer|reply|respond|fix|release|promise|escalat|credit|refund|deadline|owner|handoff)\b/i;

const NOT_SEARCHED_TALK =
  /\bnot[- ]searched|never[- ]searched|excluded|outside the (?:scope|search)\b|\bsource lookup\b.*\bfailed\b|\bfailed\b.*\bsource lookup\b/i;
const CONFLICT_TALK = /\bconflict|contradict|disagree|mismatch\b/i;
const ABSENT_TALK = /\bno record|no evidence|absent|nothing (?:was|is) (?:found|recorded)|not found|no trace\b/i;
const TOOL_CALL = /\b(?:get|search|verify|list|find|read)_[a-z0-9_]+\([^)]*\)/gi;
const TOOL_NAME = /\b(?:get|search|verify|list|find|read)_[a-z0-9_]+\b/gi;
const GENERIC_QUESTION = /^(?:could not determine|unknown|not determined)\b|\(decisions and ownership\)\s*$/i;

export function cleanGapText(text: string): string {
  return text
    .replace(TOOL_CALL, "the source lookup")
    .replace(TOOL_NAME, "the source lookup")
    .replace(/\bthe the\b/gi, "the")
    .replace(/\bclaims? \d+(?:\s*,\s*\d+)*/gi, "stored findings")
    .replace(/\b(?:e|ev|claim|event|item|note|g|gap)_[a-z0-9_]+/gi, "a stored record")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "a stored record")
    .replace(/\bI was unable to\b/gi, "we could not")
    .replace(/\bI (?:could not|cannot|can't)\b/gi, "we could not")
    .replace(/\bI (?:searched|checked)\b/gi, "we searched")
    .replace(/\s+/g, " ")
    .trim();
}

function tagFor(text: string): GapTag {
  if (NOT_SEARCHED_TALK.test(text)) return "not-searched";
  if (CONFLICT_TALK.test(text)) return "conflicting";
  if (ABSENT_TALK.test(text)) return "searched-absent";
  return "open";
}

export function rankGaps(gaps: Gap[], coverage?: CoverageReport): RankedGap[] {
  const seen = new Set<string>();
  const ranked: RankedGap[] = [];

  for (const gap of gaps) {
    let question = cleanGapText(gap.question);
    let note = cleanGapText(gap.note);
    // Skeptic notes often reuse an umbrella question ("Could not determine
    // (decisions and ownership)") and put the actual unknown in the note.
    // Promote that note so the manager reads nine distinct questions, not the
    // same heading nine times.
    if (GENERIC_QUESTION.test(question) && note.length > 0) {
      question = note;
      note = "";
    } else if (question === note) {
      note = "";
    }
    const key = `${question.toLowerCase()}|${note.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const text = `${question} ${note}`;
    const tag = tagFor(text);
    let rank = 0;
    if (tag === "not-searched") rank += 4;
    if (tag === "conflicting") rank += 3;
    if (tag === "searched-absent") rank += 1;
    if (CLIENT_TALK.test(text)) rank += 2;
    // A gap the coverage report can back with "never searched" outranks a
    // same-tagged guess: the manager can act on it directly.
    if (coverage && coverage.neverSearched.length > 0 && tag === "not-searched") rank += 1;

    ranked.push({ id: gap.id, question, note, tag, rank, eventIds: gap.eventIds });
  }

  return ranked.sort((a, b) => b.rank - a.rank);
}
