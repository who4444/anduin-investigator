import type { Claim, Commitment, Event } from "../types";

/* C3: deterministic contradiction detection. The skeptic LLM stays advisory;
   these detectors run in code on the canonical records and are the source of
   truth for the manager-facing audit. Each finding is a structured record
   with stable id, severity and manager-facing text. */

export interface Contradiction {
  /** Stable id: detector + first basis (e.g. "missed_promise:p1"). */
  id: string;
  detector:
    | "premature_resolution"
    | "release_fix_claim"
    | "missed_promise"
    | "unanswered_client"
    | "closure_unverified"
    | "handoff_missing"
    | "status_reversal";
  severity: "high" | "medium" | "low";
  /** Finding/claim/event ids the UI cites. */
  basis: string[];
  /** Manager-facing one-liner. */
  managerText: string;
}

export interface ClientEvidenceInput {
  domains: string[];
  actors: string[];
  channels: string[];
  threads: string[];
  eventIds: string[];
}

export interface DetectionInput {
  events: Event[];
  claims: Claim[];
  /** The canonical promise ledger (kept/broken/unclear decided in code). */
  promises: Commitment[];
  /** The record horizon (usually the case state's asOf). */
  asOf: string;
  /** Client evidence, when the client is resolved; enables the unanswered
      and still-broken detectors. */
  clientEvidence?: ClientEvidenceInput;
  /** Records that verify the fix works (QA green, client confirmation). */
  verifiedPassEventIds?: string[];
}

const DAY_MS = 86_400_000;
const STATUS_TRANSITION = /^\s*Status:\s*(.+?)\s*→\s*(.+?)\s*$/;
const RESOLVED_WORD = /\b(?:resolved|closed)\b/i;
const QA_RECORD = /\bQA\b/i;
const QA_RED =
  /\b(?:failed|failing|red|did not fix|not fixed|still blank|still wrong|still broken)\b/i;
const CLIENT_STILL_BROKEN =
  /\b(?:still (wrong|blank|broken|failing)|not fixed|did not fix|totals are (wrong|off|blank))\b/i;
const RELEASE_WORD = /\b(?:release|rollout|deploy(?:ed)?|is live|went live)\b/i;

function dateOnly(iso: string | null | undefined): string {
  return (iso ?? "").slice(0, 10);
}

function withinHorizon(ts: string, asOf: string): boolean {
  if (!ts || !asOf) return false;
  return Date.parse(ts) <= Date.parse(asOf);
}

function normalizedActorName(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function isClientEvidenceEvent(event: Event, evidence?: ClientEvidenceInput): boolean {
  if (!evidence) return false;
  if (evidence.eventIds.includes(event.id)) return true;
  const actor = event.actorResolved ?? event.actor;
  const domain = actor.match(/@([A-Za-z0-9.-]+)/)?.[1]?.toLowerCase();
  if (domain && evidence.domains.includes(domain)) return true;
  return evidence.actors.includes(normalizedActorName(actor));
}

function describeSource(event: Event): string {
  const when = dateOnly(event.ts);
  switch (event.source) {
    case "jira":
      return `the ${event.channel} record of ${when}`;
    case "email":
      return `an email of ${when}`;
    case "slack":
      return `a ${event.channel} message of ${when}`;
  }
}

/** Detectors run over the records in timestamp order; each fires at most once. */
export function detectContradictions(input: DetectionInput): Contradiction[] {
  const { events, promises, asOf } = input;
  const ordered = [...events].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (ordered.length === 0) return [];

  const results: Contradiction[] = [];
  const statusTransitions = ordered.filter((event) => STATUS_TRANSITION.test(event.text));
  const hasVerifiedPass = (input.verifiedPassEventIds ?? []).length > 0;

  for (const transition of statusTransitions) {
    const to = STATUS_TRANSITION.exec(transition.text)?.[2]?.trim() ?? "";
    if (!RESOLVED_WORD.test(to) || !withinHorizon(transition.ts, asOf)) continue;

    // A QA red or a still-broken client record on/after the resolved day,
    // with no verified pass record anywhere.
    const redAfter = ordered.find(
      (event) =>
        event.ts >= dateOnly(transition.ts) &&
        ((QA_RECORD.test(event.text) && QA_RED.test(event.text)) ||
          (isClientEvidenceEvent(event, input.clientEvidence) && CLIENT_STILL_BROKEN.test(event.text))),
    );
    if (redAfter && !hasVerifiedPass) {
      results.push({
        id: `premature_resolution:${transition.id}`,
        detector: "premature_resolution",
        severity: "high",
        basis: [transition.id, redAfter.id],
        managerText: `The ticket was marked ${to} on ${dateOnly(transition.ts)} (${describeSource(transition)}), but ${describeSource(redAfter)} still shows it failing — the closure was premature.`,
      });
    } else if (!redAfter && !hasVerifiedPass) {
      const hasAnyQa = ordered.some((event) => QA_RECORD.test(event.text));
      if (!hasAnyQa) {
        results.push({
          id: `closure_unverified:${transition.id}`,
          detector: "closure_unverified",
          severity: "medium",
          basis: [transition.id],
          managerText: `The ticket was marked ${to} on ${dateOnly(transition.ts)} with no QA or verification record.`,
        });
      }
    }
  }

  // release_fix_claim: a release/rollout record says the fix is included
  // while a QA record reds the same build.
  for (const release of ordered) {
    if (!RELEASE_WORD.test(release.text)) continue;
    const included = /\b(?:fix(?:es)? (?:is |are )?included|includes the fix|with the (?:invoice )?fix)\b/i.test(release.text);
    if (!included) continue;
    const qaRed = ordered.find(
      (event) => event.id !== release.id && QA_RECORD.test(event.text) && QA_RED.test(event.text),
    );
    if (qaRed) {
      results.push({
        id: `release_fix_claim:${release.id}`,
        detector: "release_fix_claim",
        severity: "high",
        basis: [release.id, qaRed.id],
        managerText: `A release record of ${dateOnly(release.ts)} says the fix is included, but ${describeSource(qaRed)} still reports it failing.`,
      });
      break;
    }
  }

  // missed_promise: deadline < asOf and no delivery evidence.
  for (const promise of promises) {
    const deadline = promise.deadlineIso ? Date.parse(promise.deadlineIso) : NaN;
    if (Number.isNaN(deadline)) continue;
    const horizon = asOf ? Date.parse(asOf) : NaN;
    const overdue = !Number.isNaN(horizon) && horizon >= deadline + DAY_MS;
    const delivered = promise.fulfilmentEventIds.length > 0;
    if (overdue && !delivered) {
      results.push({
        id: `missed_promise:${promise.id}`,
        detector: "missed_promise",
        severity: "high",
        basis: [...promise.sourceEventIds],
        managerText: `${promise.promisor ?? "The vendor"} promised ${promise.promisee ?? "the client"} "${promise.object}" by ${dateOnly(promise.deadlineIso)}; as of ${dateOnly(asOf)} no record shows it shipping.`,
      });
    }
  }

  // unanswered_client: client messages after the last vendor-authored record.
  if (input.clientEvidence) {
    const lastVendor = [...ordered].reverse().find((event) => !isClientEvidenceEvent(event, input.clientEvidence));
    const vendorTs = dateOnly(lastVendor?.ts ?? "");
    const unanswered = ordered.filter(
      (event) => isClientEvidenceEvent(event, input.clientEvidence) && (vendorTs === "" || event.ts > vendorTs),
    );
    if (unanswered.length > 0) {
      results.push({
        id: `unanswered_client:${unanswered[unanswered.length - 1].id}`,
        detector: "unanswered_client",
        severity: "high",
        basis: unanswered.map((event) => event.id),
        managerText:
          vendorTs === ""
            ? `The client messaged ${unanswered.length} time${unanswered.length === 1 ? "" : "s"} with no vendor reply in the records searched.`
            : `The client messaged after the last vendor reply (${vendorTs}) with no response in the records searched.`,
      });
    }
  }

  // handoff_missing: someone on leave / no handoff while the ticket stays open.
  const leave = ordered.find((event) => /\b(?:on leave|out of office)\b/i.test(event.text));
  const noHandoff = ordered.find((event) => /\bno handoff\b/i.test(event.text));
  if (leave && noHandoff && leave !== noHandoff) {
    results.push({
      id: `handoff_missing:${noHandoff.id}`,
      detector: "handoff_missing",
      severity: "medium",
      basis: [leave.id, noHandoff.id],
      managerText: `An owner went on leave (${dateOnly(leave.ts)}) with no handoff recorded while the work stayed open.`,
    });
  }

  return results;
}
