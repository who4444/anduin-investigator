import type { SourceKind } from "../types";

/* The decision layer's canonical shapes (docs/decision-layer-plan.md §3).
   The report model builds these; the page and API render them. Types only —
   every builder computes from stored events/claims/commitments at report time. */

export type FactState = "verified" | "supported" | "unverified" | "rejected";

export type FactCategory =
  | "cause"
  | "promise"
  | "status"
  | "ownership"
  | "communication"
  | "process"
  | "fix";

export interface Fact {
  id: string;
  category: FactCategory;
  /** Representative claim text — never a merged paraphrase. */
  statement: string;
  actorId: string | null;
  ts: string;
  source: SourceKind;
  eventIds: string[];
  /** All restatements retained. */
  claimIds: string[];
  /** Representative state; a supported restatement never downgrades a verified one. */
  state: FactState;
  clientSafe: boolean;
  flags: ("conflict" | "needs_check")[];
  /** Finding/claim ids the UI cites. */
  basis: string[];
}

export type PromiseStatus = "kept" | "broken" | "unclear" | "withdrawn";

export interface PromiseRecord {
  id: string;
  promisorActorId: string | null;
  promisee: string | null;
  object: string;
  deadlineIso: string | null;
  status: PromiseStatus;
  statusBasis: string[];
  claimIds: string[];
  contested: boolean;
}

export interface DecisionCounts {
  findings: number;
  verified: number;
  needsCheck: number;
  questionGroups: number;
  questions: number;
  promises: number;
  broken: number;
  kept: number;
  unclear: number;
}

export interface DecisionCountLists {
  facts: Fact[];
  verifiedFacts: Fact[];
  needsCheckFacts: Fact[];
  questions: { id: string }[];
  questionGroups: { id: string }[];
  promises: PromiseRecord[];
}

/** Counts are built from the exact lists in one place (spec §A3). */
export function buildDecisionCounts(lists: DecisionCountLists): DecisionCounts {
  const counts: DecisionCounts = {
    findings: lists.facts.length,
    verified: lists.verifiedFacts.length,
    needsCheck: lists.needsCheckFacts.length,
    questionGroups: lists.questionGroups.length,
    questions: lists.questions.length,
    promises: lists.promises.length,
    broken: lists.promises.filter((p) => p.status === "broken").length,
    kept: lists.promises.filter((p) => p.status === "kept").length,
    unclear: lists.promises.filter((p) => p.status === "unclear").length,
  };
  assertCounts(lists, counts);
  return counts;
}

/** Throws on any mismatch — a count derived twice is a bug (spec §A3). */
export function assertCounts(lists: DecisionCountLists, counts: DecisionCounts): void {
  const check = (name: keyof DecisionCounts, value: number, expected: number): void => {
    if (value !== expected) {
      throw new Error(`count invariant violated: ${name} is ${value}, expected ${expected}`);
    }
  };
  check("findings", counts.findings, lists.facts.length);
  check("verified", counts.verified, lists.verifiedFacts.length);
  check("needsCheck", counts.needsCheck, lists.needsCheckFacts.length);
  check("questions", counts.questions, lists.questions.length);
  check("questionGroups", counts.questionGroups, lists.questionGroups.length);
  check("promises", counts.promises, lists.promises.length);
  check("broken", counts.broken, lists.promises.filter((p) => p.status === "broken").length);
  check("kept", counts.kept, lists.promises.filter((p) => p.status === "kept").length);
  check("unclear", counts.unclear, lists.promises.filter((p) => p.status === "unclear").length);
}
