"use client";

import { useEffect, useState } from "react";

import { highlightSegments } from "@/lib/highlight";
import type { Claim, Event } from "@/lib/types";

export const SOURCE_CLASS: Record<string, string> = {
  jira: "chip chip-source-jira",
  email: "chip chip-source-email",
  slack: "chip chip-source-slack",
};

export const OUTCOME_CLASS: Record<string, string> = {
  kept: "chip chip-verified",
  broken: "chip chip-broken",
  unclear: "chip chip-unclear",
  "n/a": "chip",
};

export function SourceChip({ source }: { source: string }) {
  return <span className={SOURCE_CLASS[source] ?? "chip"}>{source}</span>;
}

export function VerificationChip({ verification }: { verification: "verified" | "supported" }) {
  if (verification === "verified") return null;
  return (
    <span
      className="chip chip-check"
      title="One verification layer did not fully pass — check before repeating externally."
    >
      check before repeating
    </span>
  );
}

const VERIFY_LABEL: Record<string, string> = {
  verified: "verified end-to-end",
  supported: "check before repeating",
  rejected: "rejected",
  unverified: "not yet verified",
};

const VERIFY_CLASS: Record<string, string> = {
  verified: "chip chip-verified",
  supported: "chip chip-check",
  rejected: "chip chip-broken",
  unverified: "chip",
};

const ATTRIBUTION_NOTE: Record<string, string> = {
  actor_mismatch: "The claim names a different author than the record.",
  ts_mismatch: "The claim's timestamp does not match the record.",
  invalid_ts: "The claim's timestamp could not be read.",
};

const ENTAILMENT_NOTE: Record<string, string> = {
  supports: "supports the claim",
  partial: "supports only part of the claim",
  refutes: "does not support the claim",
  unavailable: "did not run",
};

function ClaimChecks({ claim }: { claim: Claim }) {
  const checks = claim.checks;
  return (
    <div className="drawer-checks">
      <span className={VERIFY_CLASS[claim.verifyStatus] ?? "chip"}>
        {VERIFY_LABEL[claim.verifyStatus] ?? claim.verifyStatus}
      </span>
      <ul className="check-list small muted">
        {checks?.quote && (
          <li>
            Quote: {checks.quote.ok ? "found verbatim in this stored record" : "not found in this record"}.
          </li>
        )}
        {checks?.attribution && (
          <li>
            Actor and time:{" "}
            {checks.attribution.ok
              ? `match this record (${checks.attribution.eventActor}).`
              : `${ATTRIBUTION_NOTE[checks.attribution.reason ?? ""] ?? "do not match this record."} Claim said ${
                  checks.attribution.claimActor ?? "nobody"
                }; the record is by ${checks.attribution.eventActor}.`}
          </li>
        )}
        {checks?.entailment && (
          <li>
            Isolated model check: {ENTAILMENT_NOTE[checks.entailment.verdict] ?? checks.entailment.verdict}
            {checks.entailment.error ? ` (${checks.entailment.error})` : ""}.
          </li>
        )}
        {claim.verifyError && <li>Recorded reason: {claim.verifyError}.</li>}
      </ul>
    </div>
  );
}

export function OutcomeChip({ outcome, judged = true }: { outcome: string; judged?: boolean }) {
  const label = outcome === "n/a" ? "recorded" : outcome;
  return <span className={OUTCOME_CLASS[outcome] ?? "chip"} {...(judged ? { title: "System classification" } : {})}>{label}</span>;
}

interface DrawerProps {
  eventId: string;
  claimId?: string;
  events: Event[];
  claims: Claim[];
  onClose: () => void;
}

export function EvidenceDrawer({ eventId, claimId, events, claims, onClose }: DrawerProps) {
  const [copied, setCopied] = useState(false);
  const event = events.find((candidate) => candidate.id === eventId);

  useEffect(() => {
    const onKey = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!event) {
    return (
      <div className="drawer-backdrop" onClick={onClose}>
        <aside className="drawer" role="dialog" aria-modal="true" onClick={(clickEvent) => clickEvent.stopPropagation()}>
          <p className="muted small">This record is not in the stored evidence.</p>
        </aside>
      </div>
    );
  }

  const relevant = claims.filter(
    (claim) => claim.eventId === event.id && claim.verifyStatus !== "rejected",
  );
  const focusClaim = claimId ? claims.find((claim) => claim.id === claimId) : undefined;
  const quotes = (focusClaim ? [focusClaim] : relevant).map((claim) => claim.quote);
  const segments = highlightSegments(event.text, quotes);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(event.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied.
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Stored original message"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="spread">
          <span className="small muted">
            {event.ts} · {event.actorResolved ?? event.actor} · {event.channel} · <SourceChip source={event.source} />
          </span>
          <button type="button" className="btn btn-quiet drawer-close" onClick={onClose} aria-label="Close evidence">
            Close
          </button>
        </div>

        <p className="evidence">
          {segments.map((segment, index) =>
            segment.highlighted ? (
              <mark key={index}>{segment.text}</mark>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </p>

        {focusClaim && (
          <p className="small muted">
            Cited by: {focusClaim.text}
          </p>
        )}

        {focusClaim && <ClaimChecks claim={focusClaim} />}

        {event.refs && event.refs.length > 0 && (
          <p className="small muted">Related tickets: {event.refs.join(", ")}</p>
        )}

        <div className="row">
          <button type="button" className="btn" onClick={copy}>
            {copied ? "Copied" : "Copy text"}
          </button>
          {event.url && (
            <a className="btn" href={event.url} target="_blank" rel="noreferrer">
              Open original
            </a>
          )}
        </div>
      </aside>
    </div>
  );
}
