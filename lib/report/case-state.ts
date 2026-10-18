import type { Claim, Commitment, Event, SkepticNote } from "../types";

/* G-06 + C1: what is true NOW, computed from stored records only. Every field
   is either evidence-linked or explicitly unknown with a reason — the report
   must never guess a status, an owner or a fix date. This is THE case state:
   the report model and the reply both read it; no parallel state exists. */

export interface CaseStateValue<T> {
  known: true;
  value: T;
  since?: string | null;
  eventId: string;
  /** C1: how the record is known — a Jira transition, a message, a claim. */
  basisLabel?: string | null;
  /** B5: finding ids backing this value, for citations. */
  basis?: string[];
}

export interface CaseStateUnknown {
  known: false;
  value: null;
  reason: string;
  eventId?: null;
}

export type CaseStateField<T> = CaseStateValue<T> | CaseStateUnknown;

export interface CaseFix {
  text: string;
  ts: string;
  /** C1: an attempted fix that a later QA record contradicts. */
  label?: string | null;
}

export interface CaseState {
  /** The horizon: the latest incident-relevant record's timestamp. */
  asOf: string;
  currentStatus: CaseStateField<string>;
  latestFix: CaseStateField<CaseFix>;
  fixCheck: CaseStateField<string>;
  owner: CaseStateField<string>;
  /** C1: who made the last status change, when no owner is recorded. */
  statusChangedBy: CaseStateField<string>;
  nextCommitment: CaseStateField<{ object: string; deadline: string | null; claimId: string }>;
  lastClientContact: CaseStateField<{ actor: string; ts: string }>;
  lastInternalUpdate: CaseStateField<{ actor: string; ts: string }>;
}

import {
  ASSIGNEE_TRANSITION,
  DELIVERY_WORD,
  FIX_WORD,
  incidentRelevantEventIds,
  STATUS_TRANSITION,
  VERSION_TOKEN,
} from "./silence";

const QA_EVENT = /\bQA\b/i;
/* "until QA passes" is a plan, not a result. */
const QA_OUTCOME = /\b(?:failed|failing|passed|green|red)\b/i;
const EMAIL_DOMAIN = /@([A-Za-z0-9.-]+)/;

function actorDomain(event: Event): string | null {
  const actor = event.actorResolved ?? event.actor;
  return actor.match(EMAIL_DOMAIN)?.[1]?.toLowerCase() ?? null;
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/** C1: a clean display name — decoded, address-free. */
function displayName(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value: string | null | undefined): string {
  return displayName(value)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

const STATUS_CLAIM =
  /\b(?:marked|set|moved(?: to)?|re-?opened?|resolved|closed|in progress|reopened)\b/i;

export function buildCaseState(input: {
  events: Event[];
  claims: Claim[];
  commitments?: Commitment[];
  gaps?: import("../types").Gap[];
  notes?: SkepticNote[];
  clientDomains?: string[];
  clientActors?: string[];
}): CaseState {
  const ordered = [...input.events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const clientDomains = new Set((input.clientDomains ?? []).map((domain) => domain.toLowerCase()));
  const clientActors = new Set((input.clientActors ?? []).map(normalizeName).filter(Boolean));
  const isClientEvent = (event: Event): boolean => {
    const domain = actorDomain(event);
    if (domain && clientDomains.has(domain)) return true;
    return [event.actor, event.actorResolved ?? ""].some((value) =>
      clientActors.has(normalizeName(value)),
    );
  };
  const unknown = (reason: string): CaseStateUnknown => ({ known: false, value: null, reason });

  // Incident relevance bounds the horizon and the contact metrics: channel
  // chatter and distractor noise never set or break a window (C5).
  const relevant = incidentRelevantEventIds({
    events: input.events,
    claims: input.claims,
    commitments: input.commitments,
    gaps: input.gaps,
    notes: input.notes,
  });
  const scopedRecords = ordered.filter((event) => relevant.has(event.id));
  const horizonRecords = scopedRecords.length > 0 ? scopedRecords : ordered;
  const asOf = horizonRecords.length > 0 ? horizonRecords[horizonRecords.length - 1].ts : "";

  // Jira changelog transitions are the canonical status/assignee record; the
  // LATEST transition wins, so a reopen after a premature Resolved is what
  // shows as the current state.
  let currentStatus: CaseStateField<string> = unknown("no status transition is recorded and no verified status claim exists");
  let statusChangedBy: CaseStateField<string> = unknown("no status change actor is recorded");
  let owner: CaseStateField<string> = unknown("no assignee transition is recorded");
  let latestFix: CaseStateField<CaseFix> = unknown("no record shows a fix shipping");
  let fixCheck: CaseStateField<string> = unknown("no QA record was found");

  for (const event of horizonRecords) {
    const status = event.text.match(STATUS_TRANSITION);
    if (status) {
      currentStatus = {
        known: true,
        value: status[2].trim(),
        since: event.ts,
        eventId: event.id,
        basisLabel: `${event.source === "jira" ? "Jira status transition" : `${event.source} message`} on ${event.ts.slice(0, 10)}`,
      };
      statusChangedBy = {
        known: true,
        value: displayName(event.actorResolved ?? event.actor) || "unknown",
        since: event.ts,
        eventId: event.id,
      };
    }
    const assignee = event.text.match(ASSIGNEE_TRANSITION);
    if (assignee) {
      const name = assignee[2].trim();
      owner = /^unassigned$/i.test(name)
        ? unknown(`the latest assignee change unassigned the ticket (${event.ts.slice(0, 10)})`)
        : { known: true, value: name, since: event.ts, eventId: event.id };
    }
    if (
      !isClientEvent(event) &&
      VERSION_TOKEN.test(event.text) &&
      FIX_WORD.test(event.text) &&
      DELIVERY_WORD.test(event.text)
    ) {
      latestFix = {
        known: true,
        value: { text: shorten(event.text), ts: event.ts },
        since: event.ts,
        eventId: event.id,
      };
    }
    if (QA_EVENT.test(event.text) && QA_OUTCOME.test(event.text)) {
      fixCheck = { known: true, value: shorten(event.text), since: event.ts, eventId: event.id };
    }
  }

  // C1: no transition — the latest verified status claim stands in, clearly
  // labelled. A client complaint is never a status.
  if (!currentStatus.known) {
    const statusClaims = input.claims
      .filter(
        (claim) =>
          (claim.verifyStatus === "verified" || claim.verifyStatus === "supported") &&
          !claim.review &&
          STATUS_CLAIM.test(claim.text),
      )
      .map((claim) => ({ claim, event: ordered.find((e) => e.id === claim.eventId) }))
      .filter((entry) => entry.event)
      .sort((a, b) => ((a.event!.ts ?? "") < (b.event!.ts ?? "") ? -1 : 1));
    const latest = statusClaims[statusClaims.length - 1];
    if (latest) {
      currentStatus = {
        known: true,
        value: latest.claim.text.replace(/^.*?\b(?:marked|told the channel|said)\b\s*/i, "").slice(0, 120) || "recorded as resolved",
        since: latest.event!.ts,
        eventId: latest.event!.id,
        basisLabel: `verified claim citing ${latest.event!.source} on ${latest.event!.ts.slice(0, 10)}`,
      };
    }
  }

  // C1: no assignee transition — a verified ownership/handoff claim stands
  // in; otherwise "No owner recorded" with the last status change as its own
  // labelled field.
  if (!owner.known) {
    const ownershipClaims = input.claims
      .filter(
        (claim) =>
          (claim.verifyStatus === "verified" || claim.verifyStatus === "supported") &&
          !claim.review &&
          (claim.type === "ownership" || /took over|owns|owner|took ownership|handoff|hand(ed)? over/i.test(claim.text)),
      )
      .map((claim) => ({ claim, event: ordered.find((e) => e.id === claim.eventId) }))
      .filter((entry) => entry.event)
      .sort((a, b) => ((a.event!.ts ?? "") < (b.event!.ts ?? "") ? -1 : 1));
    const latest = ownershipClaims[ownershipClaims.length - 1];
    if (latest) {
      owner = {
        known: true,
        value: displayName(latest.claim.actor) || displayName(latest.event!.actor) || "recorded owner",
        since: latest.event!.ts,
        eventId: latest.event!.id,
        basisLabel: "verified ownership claim",
      };
    }
  }

  // C1: a later QA failure contradicting the latest fix keeps the record but
  // labels it an attempted fix — never presented as the latest working fix.
  if (latestFix.known && fixCheck.known && (fixCheck.since ?? "") >= (latestFix.since ?? "")) {
    if (/fail|failing|did not fix|not fixed|still blank|still wrong/i.test(fixCheck.value)) {
      latestFix = {
        ...latestFix,
        value: { ...latestFix.value, label: "attempted fix, QA failed" },
      };
    }
  }

  // The next commitment: the earliest open promise that carries a date
  // beyond the record horizon ("when is this fixed?" has an answer only
  // when a record states one). A promise the manager reviewed away is not
  // part of "what is true now" (G-14).
  const reviewedClaimIds = new Set(
    input.claims.filter((claim) => claim.review).map((claim) => claim.id),
  );
  const openPromises = (input.commitments ?? [])
    .filter(
      (commitment) =>
        !reviewedClaimIds.has(commitment.claimId) &&
        commitment.status !== "kept" &&
        commitment.status !== "withdrawn" &&
        commitment.deadlineIso !== null &&
        (asOf === "" || commitment.deadlineIso > asOf),
    )
    .sort((a, b) => ((a.deadlineIso ?? "") < (b.deadlineIso ?? "") ? -1 : 1));
  const nextCommitment: CaseStateField<{ object: string; deadline: string | null; claimId: string }> =
    openPromises.length > 0
      ? {
          known: true,
          value: {
            object: openPromises[0].object,
            deadline: openPromises[0].deadlineIso,
            claimId: openPromises[0].claimId,
          },
          since: openPromises[0].deadlineIso,
          eventId: openPromises[0].sourceEventIds[0] ?? "",
        }
      : unknown("no open promise carries a date");

  // B5: last client contact from CLIENT EVIDENCE on incident-relevant
  // records — the client's chases about this issue, never general chatter.
  const clientEvents = horizonRecords.filter(
    (event) => isClientEvent(event) && (event.source === "email" || relevant.has(event.id)),
  );
  const lastClient: CaseStateField<{ actor: string; ts: string }> =
    clientEvents.length > 0
      ? {
          known: true,
          value: {
            actor: displayName(clientEvents[clientEvents.length - 1].actorResolved ?? clientEvents[clientEvents.length - 1].actor),
            ts: clientEvents[clientEvents.length - 1].ts,
          },
          since: clientEvents[clientEvents.length - 1].ts,
          eventId: clientEvents[clientEvents.length - 1].id,
        }
      : unknown(
          clientDomains.size === 0 && clientActors.size === 0
            ? "no client evidence is confirmed for this investigation"
            : "no client-authored record in the incident-relevant set",
        );

  const internal = horizonRecords.filter((event) => !isClientEvent(event));
  const lastInternal: CaseStateField<{ actor: string; ts: string }> =
    internal.length > 0
      ? {
          known: true,
          value: {
            actor: displayName(internal[internal.length - 1].actorResolved ?? internal[internal.length - 1].actor),
            ts: internal[internal.length - 1].ts,
          },
          since: internal[internal.length - 1].ts,
          eventId: internal[internal.length - 1].id,
        }
      : unknown("no internal record in the incident-relevant set");

  return {
    asOf,
    currentStatus,
    latestFix,
    fixCheck,
    owner,
    statusChangedBy,
    nextCommitment,
    lastClientContact: lastClient,
    lastInternalUpdate: lastInternal,
  };
}
