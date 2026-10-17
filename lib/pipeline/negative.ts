import type { Event, InvestigationScope, Stage } from "../types";
import { buildCoverage } from "./coverage";
import { excludedClientEvidence } from "./scope";

/* G-03: claims about ABSENCE ("no reply", "never shipped", "no handoff") are
   only as true as the search behind them. They are classified here, and they
   carry a completeness proof built from what was actually searched — never
   from what the model believes. Code, not the agent, decides the state. */

export type NegativeSubject = "reply" | "handoff" | "release" | "confirmation" | "record";

export interface NegativeClassification {
  isNegative: boolean;
  subject: NegativeSubject | null;
}

const NEGATIVE_PATTERNS: { subject: NegativeSubject; pattern: RegExp }[] = [
  {
    subject: "reply",
    pattern:
      /\bno (?:reply|replies|response|responses|answer|answers)\b|\bnever (?:replied|responded|answered)\b|\bwent unanswered\b|\bunanswered\b/i,
  },
  {
    subject: "handoff",
    pattern:
      /\bno handoff\b|\bno handover\b|\bwithout (?:a )?handoff\b|\bno one (?:took over|picked (?:it|this) up)\b/i,
  },
  {
    subject: "release",
    pattern:
      /\bnever (?:shipped|released|deployed|delivered)\b|\b(?:was|were|is|are) not (?:shipped|released|deployed|delivered)\b|\bdid not ship\b|\bno fix was\b|\bwas never fixed\b/i,
  },
  {
    subject: "confirmation",
    pattern: /\bno (?:confirmation|acknowledg(?:e)?ment)\b|\bnever confirmed\b|\bnever acknowledged\b/i,
  },
  {
    subject: "record",
    pattern: /\bno (?:record|records|evidence|documentation)\b|\bthere is no (?:record|evidence)\b/i,
  },
];

export function classifyNegative(text: string): NegativeClassification {
  for (const { subject, pattern } of NEGATIVE_PATTERNS) {
    if (pattern.test(text)) return { isNegative: true, subject };
  }
  return { isNegative: false, subject: null };
}

export interface NegativeCompleteness {
  complete: boolean;
  /** Human-readable basis: what was searched, and what was not. */
  basis: string;
  failedQueries: number;
  notSearched: string[];
  excludedClientRecords: number;
}

/* A negative is complete only when nothing relevant was left unexamined:
   every available source was actually searched, no query errored, and no
   client-authored record sat outside the scope. */
export function negativeCompleteness(input: {
  events: Event[];
  stages: Stage[];
  timeline: Event[];
  scope: InvestigationScope | null;
}): NegativeCompleteness {
  const coverage = buildCoverage(input.events, input.stages, input.timeline);
  const failedQueries = coverage.sources.reduce((sum, entry) => sum + entry.failedQueries.length, 0);
  const excludedClientRecords = excludedClientEvidence(input.events, input.scope).excludedEventIds
    .length;
  const notSearched = coverage.neverSearched;
  const complete = failedQueries === 0 && excludedClientRecords === 0 && notSearched.length === 0;

  const available = coverage.sources.filter((entry) => entry.available > 0);
  const searched = available.filter((entry) => entry.searched);
  const parts = [`${searched.length}/${available.length} sources searched`];
  if (excludedClientRecords > 0) parts.push(`${excludedClientRecords} client records excluded`);
  if (notSearched.length > 0) parts.push(`${notSearched.join(", ")} never searched`);
  if (failedQueries > 0) parts.push(`${failedQueries} failed queries`);

  return {
    complete,
    basis: parts.join(" · "),
    failedQueries,
    notSearched,
    excludedClientRecords,
  };
}

/* Verification codes that mark a negative claim. Both are "supported" at
   most — a negative inference is never "verified" (invariant, GAPS §9). */
export const NEGATIVE_VERIFY_ERRORS = new Set(["evidence_incomplete", "negative_inference"]);
