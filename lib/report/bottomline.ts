import type { Claim, Commitment, Event, Gap, SkepticNote } from "../types";
import { buildLedger, buildMetrics } from "./build";

export type BottomLineTone = "neutral" | "good" | "warn" | "bad";

export interface BottomLineCell {
  id: "cause" | "promises" | "chasers" | "silence" | "questions";
  label: string;
  value: string;
  detail?: string;
  tone: BottomLineTone;
  determined: boolean;
  claimIds: string[];
  eventIds: string[];
}

export interface BottomLine {
  cells: BottomLineCell[];
}

export interface BottomLineInput {
  events: Event[];
  claims: Claim[];
  notes: SkepticNote[];
  gaps: Gap[];
  commitments?: Commitment[];
}

function shorten(text: string, maxWords = 9): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const words = flat.split(" ");
  const cut = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${cut}…` : cut;
}

function visibleClaims(claims: Claim[]): Claim[] {
  return claims.filter(
    (claim) => claim.verifyStatus === "verified" || claim.verifyStatus === "supported",
  );
}

export function buildBottomLine(input: BottomLineInput): BottomLine {
  const { events, claims, notes, gaps } = input;
  const metrics = buildMetrics({ events, claims, notes });
  const byMetric = new Map(metrics.map((metric) => [metric.id, metric]));
  const eventsById = new Map(events.map((event) => [event.id, event]));

  const cell = (
    id: BottomLineCell["id"],
    label: string,
    value: string,
    tone: BottomLineTone,
    determined: boolean,
    claimIds: string[],
    eventIds: string[],
    detail?: string,
  ): BottomLineCell => ({ id, label, value, tone, determined, claimIds, eventIds, ...(detail ? { detail } : {}) });

  // 1. root cause — prefer an unflagged cause over a contested one, earliest first.
  const causeClaims = visibleClaims(claims)
    .filter((claim) => claim.type === "root_cause" && eventsById.has(claim.eventId))
    .sort((a, b) => {
      const flag = Number(a.skepticFlag) - Number(b.skepticFlag);
      if (flag !== 0) return flag;
      const left = eventsById.get(a.eventId)!.ts;
      const right = eventsById.get(b.eventId)!.ts;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const cause = causeClaims[0]
    ? cell(
        "cause",
        "What went wrong",
        shorten(causeClaims[0].text),
        causeClaims[0].skepticFlag ? "warn" : "neutral",
        true,
        causeClaims.map((claim) => claim.id),
        [causeClaims[0].eventId],
        causeClaims[0].skepticFlag
          ? `${causeClaims[0].text} — flagged in skeptic review; check before relying on it`
          : causeClaims[0].text,
      )
    : cell("cause", "What went wrong", "not determined", "neutral", false, [], []);

  // 2. promises — the canonical ledger (structured commitments when present,
  // claim clusters otherwise); broken outweighs kept in code, not here.
  const ledger = buildLedger(input);
  const broken = ledger.filter((row) => row.outcome === "broken").length;
  const kept = ledger.filter((row) => row.outcome === "kept").length;
  const unclear = ledger.length - broken - kept;
  let promiseValue = "no promises found";
  let promiseTone: BottomLineTone = "neutral";
  if (ledger.length > 0) {
    if (broken > 0) {
      promiseValue = `${broken} of ${ledger.length} broken`;
      promiseTone = "bad";
    } else if (kept === ledger.length) {
      promiseValue = `${kept} of ${ledger.length} kept`;
      promiseTone = "good";
    } else {
      promiseValue = "outcome unclear";
      promiseTone = "warn";
    }
  }
  const promises = cell(
    "promises",
    "Promises",
    promiseValue,
    promiseTone,
    ledger.length > 0,
    ledger.flatMap((row) => row.claimIds),
    ledger.flatMap((row) => (row.eventId ? [row.eventId] : [])),
    ledger.length > 0 ? `${kept} kept · ${unclear} unclear` : undefined,
  );

  // 3. unanswered chases
  const chasers = byMetric.get("chasers")!;
  const chasersCell = cell(
    "chasers",
    "Unanswered chases",
    chasers.value,
    chasers.determined ? "bad" : "neutral",
    chasers.determined,
    chasers.claimIds,
    chasers.eventIds,
    chasers.detail,
  );

  // 4. longest silence
  const silence = byMetric.get("longestSilence")!;
  const silenceCell = cell(
    "silence",
    "Longest silence",
    silence.determined ? silence.value : "not determined",
    silence.determined ? "warn" : "neutral",
    silence.determined,
    [],
    silence.eventIds,
    silence.detail,
  );

  // 5. open questions
  const gapEventIds = [...new Set(gaps.flatMap((gap) => gap.eventIds))];
  const questions = cell(
    "questions",
    "Open questions",
    gaps.length > 0 ? `${gaps.length} open` : "none open",
    gaps.length > 0 ? "warn" : "neutral",
    gaps.length > 0,
    [],
    gapEventIds,
    gaps.length > 0 ? shorten(gaps[0].question, 12) : undefined,
  );

  return { cells: [cause, promises, chasersCell, silenceCell, questions] };
}
