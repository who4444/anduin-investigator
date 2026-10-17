import { extractJson, isPlainObject } from "../json";
import type { PlanData, PlanDateWindow, PlanHypothesis, PlanIssue, PlanSource } from "../types";

/* Structured plans: the analyst returns JSON with hypotheses to test, a source
   plan, seed terms, people, a focus window, the unknowns, and the independent
   issues the escalation contains. CODE normalizes and caps it. Anything
   unusable degrades back to free text. */

const MAX_FRAMING_CHARS = 600;
const MAX_TEXT_CHARS = 300;
const MAX_APPROACH_CHARS = 200;
const MAX_TERM_CHARS = 60;
const MAX_HYPOTHESES = 6;
const MAX_SOURCES = 6;
const MAX_TERMS = 20;
const MAX_PEOPLE = 10;
const MAX_UNKNOWNS = 8;
const MAX_ISSUES = 3;
const MAX_ISSUE_TITLE_CHARS = 120;
const MAX_ISSUE_ASK_CHARS = 600;
const MAX_ISSUE_SUMMARY_CHARS = 600;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function cleanList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanString(entry, maxChars);
    if (text) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE.test(value.trim())) return null;
  const [year, month, day] = value.trim().split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  // Reject impossible dates (2024-02-30) and out-of-range years (0000-…):
  // the UTC components must round-trip exactly.
  if (
    Number.isNaN(check.getTime()) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    year < 1970
  ) {
    return null;
  }
  return value.trim();
}

function cleanWindow(value: unknown): PlanDateWindow {
  if (!isPlainObject(value)) return { from: null, to: null };
  return { from: cleanDate(value.from), to: cleanDate(value.to) };
}

export function normalizePlanData(value: unknown): PlanData | null {
  if (!isPlainObject(value)) return null;

  const framing = cleanString(value.framing, MAX_FRAMING_CHARS);
  const hypotheses: PlanHypothesis[] = [];
  if (Array.isArray(value.hypotheses)) {
    for (const entry of value.hypotheses) {
      if (!isPlainObject(entry)) continue;
      const statement = cleanString(entry.statement, MAX_TEXT_CHARS);
      if (!statement) continue;
      hypotheses.push({
        statement,
        test: cleanString(entry.test, MAX_TEXT_CHARS),
        falsify: cleanString(entry.falsify, MAX_TEXT_CHARS),
      });
      if (hypotheses.length >= MAX_HYPOTHESES) break;
    }
  }

  const sources: PlanSource[] = [];
  if (Array.isArray(value.sources)) {
    for (const entry of value.sources) {
      if (!isPlainObject(entry)) continue;
      const source = cleanString(entry.source, 40);
      const approach = cleanString(entry.approach, MAX_APPROACH_CHARS);
      if (!source || !approach) continue;
      sources.push({ source, approach });
      if (sources.length >= MAX_SOURCES) break;
    }
  }

  const searchTerms = cleanList(value.searchTerms, MAX_TERMS, MAX_TERM_CHARS);
  const people = cleanList(value.people, MAX_PEOPLE, MAX_TERM_CHARS);
  const unknowns = cleanList(value.unknowns, MAX_UNKNOWNS, MAX_TEXT_CHARS);
  const dateWindow = cleanWindow(value.dateWindow);

  // G-23: independent issues. The model may over-split; code caps at three and
  // reports the overflow separately so the plan can say so honestly.
  const rawIssues = Array.isArray(value.issues) ? value.issues : [];
  const issues: PlanIssue[] = [];
  for (const entry of rawIssues) {
    if (!isPlainObject(entry)) continue;
    const title = cleanString(entry.title, MAX_ISSUE_TITLE_CHARS);
    if (!title) continue;
    const confidence =
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
        ? Math.min(1, Math.max(0, entry.confidence))
        : 0.5;
    issues.push({
      title,
      ask: cleanString(entry.ask, MAX_ISSUE_ASK_CHARS),
      summary: cleanString(entry.summary, MAX_ISSUE_SUMMARY_CHARS),
      confidence,
    });
    if (issues.length >= MAX_ISSUES) break;
  }
  const issueOverflow = Math.max(0, rawIssues.length - issues.length);

  const usable =
    Boolean(framing) ||
    hypotheses.length > 0 ||
    sources.length > 0 ||
    searchTerms.length > 0 ||
    people.length > 0 ||
    unknowns.length > 0 ||
    issues.length > 0;
  if (!usable) return null;

  return {
    framing,
    hypotheses,
    sources,
    searchTerms,
    people,
    dateWindow,
    unknowns,
    issues,
    issueOverflow,
  };
}

export function parsePlanData(content: string): PlanData | null {
  return normalizePlanData(extractJson(content));
}

export function renderPlan(data: PlanData): string {
  const parts: string[] = [];
  if (data.framing) parts.push(data.framing);

  if (data.issues.length > 0) {
    parts.push(
      [
        `Issues in this escalation (${data.issues.length}):`,
        ...data.issues.map(
          (issue, index) =>
            `${index + 1}. ${issue.title}${issue.ask ? ` — the client asks: ${issue.ask}` : ""}`,
        ),
        ...(data.issueOverflow > 0
          ? [
              `The escalation appears to contain ${data.issues.length + data.issueOverflow} independent issues; only the first ${data.issues.length} are in scope here. Ask the manager to split the rest.`,
            ]
          : []),
      ].join("\n"),
    );
  }

  if (data.hypotheses.length > 0) {
    parts.push(
      ["Hypotheses to test:", ...data.hypotheses.map((entry) => `- ${entry.statement} — test: ${entry.test}; falsify: ${entry.falsify}`)].join(
        "\n",
      ),
    );
  }

  if (data.sources.length > 0) {
    parts.push(["Source plan:", ...data.sources.map((entry) => `- ${entry.source}: ${entry.approach}`)].join("\n"));
  }

  if (data.searchTerms.length > 0) parts.push(`Seed terms: ${data.searchTerms.join(", ")}`);
  if (data.people.length > 0) parts.push(`People to look at: ${data.people.join(", ")}`);

  const { from, to } = data.dateWindow;
  if (from && to) parts.push(`Focus window: ${from} → ${to}`);
  else if (from) parts.push(`Focus window: from ${from}`);
  else if (to) parts.push(`Focus window: up to ${to}`);

  if (data.unknowns.length > 0) {
    parts.push(["Unknowns to keep open:", ...data.unknowns.map((entry) => `- ${entry}`)].join("\n"));
  }

  return parts.join("\n\n");
}

/* "wrong for three weeks" -> a start date relative to the reference moment.
   Only explicit relative phrasing is parsed; anything else stays null. */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const RELATIVE = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month)s?\b/gi;
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };

export function deriveDateWindow(escalation: string, referenceIso: string): PlanDateWindow {
  const reference = new Date(referenceIso);
  if (Number.isNaN(reference.getTime())) return { from: null, to: null };

  let best: number | null = null;
  for (const match of escalation.matchAll(RELATIVE)) {
    const raw = match[1].toLowerCase();
    const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (!count) continue;
    const days = count * (UNIT_DAYS[match[2].toLowerCase()] ?? 0);
    if (days > 0 && (best === null || days > best)) best = days;
  }
  if (best === null) return { from: null, to: null };

  const from = new Date(reference.getTime() - best * 86_400_000).toISOString().slice(0, 10);
  return { from, to: null };
}
