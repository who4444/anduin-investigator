import type { Claim, Commitment, Event } from "../types";

/* G-06: what is true NOW, computed from stored records only. Every field is
   either evidence-linked or explicitly unknown with a reason — the report
   must never guess a status, an owner or a fix date. */

export interface CaseStateValue<T> {
  known: true;
  value: T;
  since?: string | null;
  eventId: string;
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
}

export interface CaseState {
  /** The horizon: the latest stored record's timestamp. */
  asOf: string;
  currentStatus: CaseStateField<string>;
  latestFix: CaseStateField<CaseFix>;
  fixCheck: CaseStateField<string>;
  owner: CaseStateField<string>;
  nextCommitment: CaseStateField<{ object: string; deadline: string | null; claimId: string }>;
  lastClientContact: CaseStateField<{ actor: string; ts: string }>;
  lastInternalUpdate: CaseStateField<{ actor: string; ts: string }>;
}

const STATUS_TRANSITION = /^\s*Status:\s*(.+?)\s*→\s*(.+?)\s*$/;
const ASSIGNEE_TRANSITION = /^\s*Assignee:\s*(.+?)\s*→\s*(.+?)\s*$/;
const VERSION_TOKEN = /\b\d+\.\d+(?:\.\d+)?\b/;
const FIX_EVENT = /\b(release|build|deploy(?:ed|ment)?|hotfix|patch|shipped|is live|rolled out)\b/i;
const QA_EVENT = /\bQA\b/i;
const QA_OUTCOME = /\bfail(?:ed|ing|s)?\b|\bpass(?:ed|es|ing)?\b|\bgreen\b|\bred\b/i;
const EMAIL_DOMAIN = /@([A-Za-z0-9.-]+)/;

function actorDomain(event: Event): string | null {
  const actor = event.actorResolved ?? event.actor;
  return actor.match(EMAIL_DOMAIN)?.[1]?.toLowerCase() ?? null;
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

export function buildCaseState(input: {
  events: Event[];
  claims: Claim[];
  commitments?: Commitment[];
  clientDomains?: string[];
}): CaseState {
  const ordered = [...input.events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const asOf = ordered.length > 0 ? ordered[ordered.length - 1].ts : "";
  const clientDomains = new Set((input.clientDomains ?? []).map((domain) => domain.toLowerCase()));
  const unknown = (reason: string): CaseStateUnknown => ({ known: false, value: null, reason });

  // Jira changelog transitions are the canonical status/assignee record; the
  // LATEST transition wins, so a reopen after a premature Resolved is what
  // shows as the current state.
  let currentStatus: CaseStateField<string> = unknown("no status transition was recorded");
  let owner: CaseStateField<string> = unknown("no assignee transition was recorded");
  let latestFix: CaseStateField<CaseFix> = unknown("no release or fix record was found");
  let fixCheck: CaseStateField<string> = unknown("no QA record was found");

  for (const event of ordered) {
    const status = event.text.match(STATUS_TRANSITION);
    if (status) {
      currentStatus = { known: true, value: status[2].trim(), since: event.ts, eventId: event.id };
    }
    const assignee = event.text.match(ASSIGNEE_TRANSITION);
    if (assignee) {
      const name = assignee[2].trim();
      owner = /^unassigned$/i.test(name)
        ? unknown(`the latest assignee change unassigned the ticket (${event.ts.slice(0, 10)})`)
        : { known: true, value: name, since: event.ts, eventId: event.id };
    }
    if (VERSION_TOKEN.test(event.text) && FIX_EVENT.test(event.text)) {
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

  // The next commitment: the earliest open promise that carries a date
  // beyond the record horizon ("when is this fixed?" has an answer only
  // when a record states one).
  const openPromises = (input.commitments ?? [])
    .filter(
      (commitment) =>
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

  const clientEvents = ordered.filter((event) => {
    const domain = actorDomain(event);
    return domain !== null && clientDomains.has(domain);
  });
  const lastClient: CaseStateField<{ actor: string; ts: string }> =
    clientEvents.length > 0
      ? {
          known: true,
          value: {
            actor: clientEvents[clientEvents.length - 1].actorResolved ?? clientEvents[clientEvents.length - 1].actor,
            ts: clientEvents[clientEvents.length - 1].ts,
          },
          since: clientEvents[clientEvents.length - 1].ts,
          eventId: clientEvents[clientEvents.length - 1].id,
        }
      : unknown(
          clientDomains.size === 0
            ? "no client domain is confirmed for this investigation"
            : "no client-authored record in scope",
        );

  const internal = ordered.filter((event) => {
    const domain = actorDomain(event);
    return domain === null || !clientDomains.has(domain);
  });
  const lastInternal: CaseStateField<{ actor: string; ts: string }> =
    internal.length > 0
      ? {
          known: true,
          value: {
            actor: internal[internal.length - 1].actorResolved ?? internal[internal.length - 1].actor,
            ts: internal[internal.length - 1].ts,
          },
          since: internal[internal.length - 1].ts,
          eventId: internal[internal.length - 1].id,
        }
      : unknown("no internal record in scope");

  return {
    asOf,
    currentStatus,
    latestFix,
    fixCheck,
    owner,
    nextCommitment,
    lastClientContact: lastClient,
    lastInternalUpdate: lastInternal,
  };
}
