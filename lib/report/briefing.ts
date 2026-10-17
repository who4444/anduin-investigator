import type { Claim, Commitment, Event, SourceKind } from "../types";
import {
  buildLedger,
  buildSilences,
  clusterCommitments,
  effectiveTs,
  type TimelineSilenceRow,
} from "./build";

export type Importance = "key" | "normal" | "routine";
export type Lane = "client" | "promises" | "owner" | "ticket" | "engineering";
export type FindingTag = "technical" | "process" | "communication";

export interface BriefingEvent {
  id: string;
  claimId: string;
  headline: string;
  text: string;
  importance: Importance;
  type: string;
  lane: Lane;
  actor: string;
  actorRole: string;
  actorColor: number;
  source: SourceKind;
  ts: string;
  dayNumber: number;
  status: string;
  flagged: boolean;
  judged: boolean;
  verification: "verified" | "supported";
}

export interface BriefingChapter {
  id: string;
  title: string;
  from: string;
  to: string;
  takeaway: string;
  eventIds: string[];
}

export interface KeyMoment {
  id: string;
  headline: string;
  claimId: string;
  tag: FindingTag;
  date: string;
  people: string[];
  verification: "verified" | "supported";
}

export interface Person {
  name: string;
  role: string;
  colorIndex: number;
  mentions: number;
}

export interface BriefingSilence extends TimelineSilenceRow {
  quietSources: SourceKind[];
  leaveNote: boolean;
}

export interface Briefing {
  narrative: string;
  confidence: {
    verified: number;
    supported: number;
    rejected: number;
    total: number;
    flagged: number;
  };
  chapters: BriefingChapter[];
  events: BriefingEvent[];
  keyMoments: KeyMoment[];
  people: Person[];
  lanes: Lane[];
  silences: BriefingSilence[];
}

const LANES: Lane[] = ["client", "promises", "owner", "ticket", "engineering"];
const CLIENT_CHANNEL = /client/i;
const TICKET_CHANNEL = /^[A-Z][A-Z0-9]+-\d+$/;
const LEAVE_PATTERN = /on leave|leave|training|out of office/i;
const HANDOFF_PATTERN = /handoff|hand-off|rota|coverage|owner/i;
const MAX_CHAPTERS = 7;

function words(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const parts = cleaned.split(" ");
  if (parts.length <= limit) return cleaned.replace(/[.,;:]$/, "");
  return `${parts.slice(0, limit).join(" ")}…`;
}

function laneFor(claim: Claim, channel: string): Lane {
  if (claim.type === "commitment") return "promises";
  if (CLIENT_CHANNEL.test(channel)) return "client";
  if (claim.type === "ownership" || HANDOFF_PATTERN.test(claim.text)) return "owner";
  if (TICKET_CHANNEL.test(channel)) return "ticket";
  return "engineering";
}

function importanceFor(claim: Claim): Importance {
  if (claim.type === "commitment" && claim.status === "broken") return "key";
  if (claim.type === "process_failure" && claim.skepticFlag) return "key";
  if (/resolved|marked done|no handoff|no reply|unanswered/i.test(claim.text)) return "key";
  if (claim.type === "root_cause") return "key";
  if (claim.confidence < 0.5 && !claim.skepticFlag) return "routine";
  if (claim.type === "decision" || claim.type === "process_failure" || claim.type === "ownership") {
    return "normal";
  }
  return claim.skepticFlag || claim.confidence >= 0.5 ? "normal" : "routine";
}

function roleFor(actor: string, kept: Claim[], eventsById: Map<string, Event>): string {
  for (const claim of kept) {
    const event = eventsById.get(claim.eventId);
    if (!event) continue;
    if ((event.actorResolved ?? event.actor) === actor && CLIENT_CHANNEL.test(event.channel)) {
      return "client";
    }
  }
  return "team";
}

export function buildBriefing(input: {
  events: Event[];
  claims: Claim[];
  commitments?: Commitment[];
}): Briefing {
  const { events, claims } = input;
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const isVisible = (claim: Claim) =>
    claim.verifyStatus === "verified" || claim.verifyStatus === "supported";
  const kept = claims.filter(isVisible);

  const ordered = kept
    .map((claim) => ({ claim, event: eventsById.get(claim.eventId) }))
    .filter((entry): entry is { claim: Claim; event: Event } => entry.event !== undefined)
    .sort((a, b) => {
      const left = effectiveTs(a.claim, a.event);
      const right = effectiveTs(b.claim, b.event);
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const firstTs = ordered[0] ? ordered[0].claim.ts ?? ordered[0].event?.ts ?? "" : "";
  const dayNumber = (ts: string): number =>
    firstTs ? Math.max(1, Math.round((Date.parse(ts) - Date.parse(firstTs)) / 86_400_000) + 1) : 1;

  const clusters = clusterCommitments(claims);
  const representativeByClaim = new Map<string, string>();
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      representativeByClaim.set(member.id, cluster.representative.id);
    }
  }
  const importanceOf = (claim: Claim): Importance => {
    if (claim.type === "commitment" && representativeByClaim.get(claim.id) !== claim.id) {
      return "normal";
    }
    return importanceFor(claim);
  };

  const mentionCounts = new Map<string, { role: string; mentions: number }>();
  const rawTsByClaim = new Map<string, string>();
  const eventsOut: BriefingEvent[] = ordered.map(({ claim, event }) => {
    const ts = effectiveTs(claim, event);
    rawTsByClaim.set(claim.id, event.ts);
    const actor = event.actorResolved ?? event.actor;
    const role = roleFor(actor, kept, eventsById);
    const existing = mentionCounts.get(actor) ?? { role, mentions: 0 };
    existing.mentions += 1;
    mentionCounts.set(actor, existing);

    return {
      id: `ev_${claim.id}`,
      claimId: claim.id,
      headline: words(claim.text, 10),
      text: claim.text,
      importance: importanceOf(claim),
      type: claim.type,
      lane: laneFor(claim, event.channel),
      actor,
      actorRole: role,
      actorColor: 0,
      source: event.source,
      ts,
      dayNumber: dayNumber(ts),
      status: claim.status,
      flagged: claim.skepticFlag,
      judged: claim.type !== "root_cause" || claim.skepticFlag,
      verification: claim.verifyStatus === "verified" ? "verified" : "supported",
    };
  });

  const people: Person[] = [...mentionCounts.entries()]
    .sort((a, b) => b[1].mentions - a[1].mentions || (a[0] < b[0] ? -1 : 1))
    .map(([name, data], index) => ({
      name,
      role: data.role,
      colorIndex: index % 8,
      mentions: data.mentions,
    }));
  const peopleIndex = new Map(people.map((person) => [person.name, person.colorIndex]));
  for (const event of eventsOut) {
    event.actorColor = peopleIndex.get(event.actor) ?? 0;
  }

  // silences with scope + leave annotation. A source is quiet during the gap
  // when it has no record in (from, to] — its own record may end the silence
  // (it was quiet until that moment), but the record that starts it was active.
  const rawSilences = buildSilences(events);
  const silences: BriefingSilence[] = rawSilences.map((silence) => {
    const quietSources = (["jira", "email", "slack"] as SourceKind[]).filter(
      (source) =>
        !events.some(
          (event) => event.source === source && event.ts > silence.from && event.ts <= silence.to,
        ),
    );
    const leaveNote = kept.some((claim) => {
      const ts = claim.ts ?? eventsById.get(claim.eventId)?.ts ?? "";
      return (
        LEAVE_PATTERN.test(claim.text) && ts >= silence.from.slice(0, 10) && ts <= silence.to
      );
    });
    const scope = quietSources.length > 0 ? quietSources.join("/") : "any source";
    return {
      ...silence,
      quietSources,
      leaveNote,
      label: `${silence.days} days, no ${scope} activity.${leaveNote ? " Owner on leave." : ""}`,
    };
  });

  // chapters: cut at silences, then merge the smallest until at most seven
  interface Draft {
    events: BriefingEvent[];
  }
  const drafts: Draft[] = [];
  let current: BriefingEvent[] = [];
  for (const event of eventsOut) {
    current.push(event);
    // Compare against the underlying record's ts, not the claim's display ts —
    // a date-only or offset claim timestamp must not blind the chapter cut.
    const endsWithSilence = silences.some((silence) => silence.from === rawTsByClaim.get(event.claimId));
    if (endsWithSilence) {
      drafts.push({ events: current });
      current = [];
    }
  }
  if (current.length > 0) drafts.push({ events: current });
  if (drafts.length === 0) drafts.push({ events: [] });

  while (drafts.length > MAX_CHAPTERS) {
    let smallest = 0;
    for (let index = 1; index < drafts.length; index += 1) {
      if (drafts[index].events.length < drafts[smallest].events.length) smallest = index;
    }
    const neighbour = smallest === 0 ? 1 : smallest - 1;
    const merged = [...drafts[smallest].events, ...drafts[neighbour].events].sort((a, b) =>
      a.ts < b.ts ? -1 : 1,
    );
    const insertAt = Math.min(smallest, neighbour);
    drafts.splice(Math.max(smallest, neighbour), 1);
    drafts[insertAt] = { events: merged };
  }

  const chapters: BriefingChapter[] = drafts
    .filter((draft) => draft.events.length > 0)
    .map((draft, index) => {
      const first = draft.events[0];
      const last = draft.events[draft.events.length - 1];
      const broken = draft.events.filter((event) => event.status === "broken").length;
      const key = draft.events.filter((event) => event.importance === "key").length;
      const takeaway =
        broken > 0
          ? `${draft.events.length} findings, ${broken} broken promise${broken === 1 ? "" : "s"}.`
          : key > 0
            ? `${draft.events.length} findings, ${key} deciding moment${key === 1 ? "" : "s"}.`
            : `${draft.events.length} findings.`;
      return {
        id: `chapter_${index + 1}`,
        title: words(first.headline, 8),
        from: first.ts,
        to: last.ts,
        takeaway,
        eventIds: draft.events.map((event) => event.id),
      };
    });

  const priority = (event: BriefingEvent): number => {
    if (event.status === "broken") return 0;
    if (/resolved|marked done|no handoff|no reply|unanswered/i.test(event.text)) return 1;
    if (HANDOFF_PATTERN.test(event.text)) return 2;
    if (event.type === "root_cause") return 3;
    return 4;
  };
  const keyMoments: KeyMoment[] = eventsOut
    .filter((event) => event.importance === "key")
    .sort((a, b) => priority(a) - priority(b) || (a.ts < b.ts ? -1 : 1))
    .slice(0, 5)
    .map((event) => ({
      id: `moment_${event.claimId}`,
      headline: words(event.headline, 9),
      claimId: event.claimId,
      tag:
        event.type === "root_cause"
          ? ("technical" as const)
          : /client|told|reply|communicat|no response/i.test(event.text)
            ? ("communication" as const)
            : ("process" as const),
      date: event.ts.slice(0, 10),
      people: [event.actor],
      verification: event.verification,
    }));

  // Promise counts come from the canonical ledger (structured commitments
  // when present), the same set the promises section renders (G-05).
  const promiseLedger = buildLedger({ events, claims, notes: [], commitments: input.commitments });
  const brokenClusters = promiseLedger.filter((row) => row.outcome === "broken").length;
  const keptClusters = promiseLedger.filter((row) => row.outcome === "kept").length;
  const unclearClusters = promiseLedger.length - brokenClusters - keptClusters;
  const lastDay = eventsOut.length > 0 ? eventsOut[eventsOut.length - 1].dayNumber : 0;
  const sources = new Set(eventsOut.map((event) => event.source));
  const flagged = claims.filter((claim) => claim.skepticFlag).length;
  const supportedCount = kept.filter((claim) => claim.verifyStatus === "supported").length;
  const longestSilence = silences.reduce((longest, silence) => Math.max(longest, silence.days), 0);

  const narrativeParts: string[] = [];
  if (eventsOut.length === 0) {
    narrativeParts.push("No verified findings yet, so there is no story to tell from the records.");
  } else {
    narrativeParts.push(
      `Across ${sources.size} source${sources.size === 1 ? "" : "s"}, ${eventsOut.length} source-backed findings cover day 1 to day ${lastDay} of the incident.`,
    );
    if (supportedCount > 0) {
      narrativeParts.push(
        `${supportedCount} of them still need a human check before repeating.`,
      );
    }
    if (promiseLedger.length > 0) {
      const unclearSuffix = unclearClusters > 0 ? `, ${unclearClusters} as unclear` : "";
      narrativeParts.push(
        brokenClusters > 0
          ? `${brokenClusters} of ${promiseLedger.length} promises read as broken${keptClusters > 0 ? `, ${keptClusters} as kept` : ""}${unclearSuffix}.`
          : keptClusters === promiseLedger.length
            ? `All ${promiseLedger.length} promises read as kept.`
            : keptClusters > 0
              ? `${keptClusters} of ${promiseLedger.length} promises read as kept${unclearSuffix}.`
              : `${promiseLedger.length} promise${promiseLedger.length === 1 ? "" : "s"} read as unclear — the records do not settle the outcome.`,
      );
    } else {
      narrativeParts.push("No promises were found in the records.");
    }
    if (longestSilence >= 3) {
      narrativeParts.push(`The record goes quiet for up to ${longestSilence} days at one stretch.`);
    }
    narrativeParts.push(
      flagged > 0
        ? `${flagged} findings carry a caution flag from skeptic review.`
        : "No finding needed a caution flag.",
    );
  }

  const narrative = narrativeParts.join(" ");

  return {
    narrative,
    confidence: {
      verified: claims.filter((claim) => claim.verifyStatus === "verified").length,
      supported: claims.filter((claim) => claim.verifyStatus === "supported").length,
      rejected: claims.filter((claim) => claim.verifyStatus === "rejected").length,
      total: claims.length,
      flagged: claims.filter((claim) => claim.skepticFlag).length,
    },
    chapters,
    events: eventsOut,
    keyMoments,
    people,
    lanes: LANES,
    silences,
  };
}
