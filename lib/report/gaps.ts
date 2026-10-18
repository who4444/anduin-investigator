import type { Gap } from "../types";

/** C6: the structured categories an agent may set. */
export type GapCategory = import("../types").GapCategory;

export const GAP_CATEGORIES: GapCategory[] = [
  "scope",
  "coverage",
  "state",
  "technical",
  "commitment",
  "communication",
  "ownership",
  "other",
];
import type { CoverageReport } from "../pipeline/coverage";

/* G-11: gaps ranked by decision impact, deduped, tagged, and cleaned of
   agent voice and raw record ids. The manager reads a queue, not a wall. */

export type GapTag = "not-searched" | "conflicting" | "searched-absent" | "open";

export interface RankedGap {
  /** C6: the write-time category, when the row has one. */
  category?: GapCategory;
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
  /\bnot[- ]searched|never[- ]searched|excluded|outside the (?:scope|search)\b|\b(?:source lookup|search)\b[^.]*\bfailed\b|\bfailed\b[^.]*\b(?:source lookup|search)\b/i;
const CONFLICT_TALK = /\bconflict|contradict|disagree|mismatch\b/i;
const ABSENT_TALK = /\bno record|no evidence|absent|nothing (?:was|is) (?:found|recorded)|not found|no trace\b/i;
const TOOL_CALL = /\b(get|search|verify|list|find|read)_([a-z0-9_]+)\(([^)]*)\)/gi;
const TOOL_NAME = /\b(get|search|verify|list|find|read)_([a-z0-9_]+)\b/gi;
const UNABLE_TOOL =
  /\b(?:I was unable to|I could not|I cannot|I can't|we could not)\s+(get|search|verify|list|find|read)_([a-z0-9_]+)\(([^)]*)\)/gi;
const RAW_ID = /\b(?:e|ev|claim|event|item|note|gap|g)_[a-z0-9_]+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RAW_ID_TEST =
  /\b(?:e|ev|claim|event|item|note|gap|g)_[a-z0-9_]+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const CLAIM_NUMBER = /\bclaims?\s+\d+(?:\s*,\s*\d+|\s*\(and\s+\d+(?:\s*,\s*\d+)*\))?/gi;
const CLAIM_NUMBER_TEST = /\bclaims?\s+\d+(?:\s*,\s*\d+|\s*\(and\s+\d+(?:\s*,\s*\d+)*\))?/i;
const GENERIC_QUESTION = /^(?:could not determine|unknown|not determined)\b|\(decisions and ownership\)\s*$/i;
const PLACEHOLDER_ARG = /^(?:query|text|jql_or_text|channel|ts|id|key|date|from|to)$/i;

/* C4: a note that still carries an internal record id or a claim number has no
   manager-facing reading — the caller drops it instead of substituting a
   "stored record" placeholder. */
export function hasRawReference(text: string): boolean {
  return RAW_ID_TEST.test(text) || CLAIM_NUMBER_TEST.test(text);
}

function toolLabel(tool: string, arg: string): string {
  const detail = arg.trim().replace(/^['"]|['"]$/g, "");
  const suffix = detail && detail.length <= 48 && !PLACEHOLDER_ARG.test(detail) ? ` for ${detail}` : "";
  if (tool.startsWith("verify")) return `the quote check${suffix}`;
  if (/jira|issue/.test(tool)) return `the Jira search${suffix}`;
  if (/slack|thread/.test(tool)) return `the Slack search${suffix}`;
  if (/email|gmail|mail/.test(tool)) return `the email search${suffix}`;
  return `the source search${suffix}`;
}

export function cleanGapText(text: string): string {
  return text
    .replace(UNABLE_TOOL, (_match, tool: string, rest: string, arg: string) =>
      `${toolLabel(`${tool}_${rest}`, arg)} could not be completed`,
    )
    .replace(TOOL_CALL, (_match, tool: string, rest: string, arg: string) =>
      toolLabel(`${tool}_${rest}`, arg),
    )
    .replace(TOOL_NAME, (_match, tool: string, rest: string) => toolLabel(`${tool}_${rest}`, ""))
    .replace(/\bthe the\b/gi, "the")
    .replace(/\bI was unable to\b/gi, "we could not")
    .replace(/\bI (?:could not|cannot|can't)\b/gi, "we could not")
    .replace(/\bI (?:searched|checked)\b/gi, "we searched")
    .replace(/\bthe source lookups?\b/gi, "the search")
    .replace(CLAIM_NUMBER, " ")
    .replace(RAW_ID, " ")
    .replace(/\s*\(\s*(?:check|record|item|case|note|variant|entry)\s*#?\d+\s*\)\s*$/i, "")
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMeaning(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningTokens(text: string): Set<string> {
  return new Set(normalizeMeaning(text).split(" ").filter((token) => token.length > 2));
}

/* Near-duplicate questions differ by a parenthetical, an article or one word.
   Two gaps are the same manager question when their normalized token sets
   overlap at this threshold; the first wording is kept. */
function sameMeaning(left: string, right: string): boolean {
  const a = normalizeMeaning(left);
  const b = normalizeMeaning(right);
  if (a === b) return true;
  const leftTokens = meaningTokens(left);
  const rightTokens = meaningTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / (leftTokens.size + rightTokens.size - shared) >= 0.85;
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
  const meanings: string[] = [];

  for (const gap of gaps) {
    // C4: a gap whose text still carries an internal id or claim number has no
    // manager-facing reading; drop it rather than print a placeholder.
    if (hasRawReference(`${gap.question} ${gap.note}`)) continue;
    let question = cleanGapText(gap.question);
    let note = cleanGapText(gap.note);
    if (!question && !note) continue;
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

    const meaning = `${question} ${note}`.trim();
    if (meanings.some((existing) => sameMeaning(existing, meaning))) continue;
    meanings.push(meaning);

    ranked.push({ id: gap.id, question, note, tag, rank, eventIds: gap.eventIds, category: gap.category ?? undefined });
  }

  return ranked.sort((a, b) => b.rank - a.rank);
}
