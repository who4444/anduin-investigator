import type { Claim, Event, Gap, SkepticNote } from "../types";
import { buildMetrics, clusterCommitments } from "./build";

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

  // 1. root cause — earliest visible root-cause claim
  const causeClaims = visibleClaims(claims)
    .filter((claim) => claim.type === "root_cause" && eventsById.has(claim.eventId))
    .sort((a, b) => {
      const left = eventsById.get(a.eventId)!.ts;
      const right = eventsById.get(b.eventId)!.ts;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const cause = causeClaims[0]
    ? cell(
        "cause",
        "What went wrong",
        shorten(causeClaims[0].text),
        "neutral",
        true,
        causeClaims.map((claim) => claim.id),
        [causeClaims[0].eventId],
        causeClaims[0].text,
      )
    : cell("cause", "What went wrong", "not determined", "neutral", false, [], []);

  // 2. promises — cluster outcomes, broken outweighs kept
  const clusters = clusterCommitments(claims);
  const broken = clusters.filter((cluster) => cluster.representative.status === "broken").length;
  const kept = clusters.filter((cluster) => cluster.representative.status === "kept").length;
  const unclear = clusters.length - broken - kept;
  let promiseValue = "no promises found";
  let promiseTone: BottomLineTone = "neutral";
  if (clusters.length > 0) {
    if (broken > 0) {
      promiseValue = `${broken} of ${clusters.length} broken`;
      promiseTone = "bad";
    } else if (kept === clusters.length) {
      promiseValue = `${kept} of ${clusters.length} kept`;
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
    clusters.length > 0,
    clusters.flatMap((cluster) => cluster.members.map((member) => member.id)),
    clusters.flatMap((cluster) => cluster.members.map((member) => member.eventId)),
    clusters.length > 0 ? `${kept} kept · ${unclear} unclear` : undefined,
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
