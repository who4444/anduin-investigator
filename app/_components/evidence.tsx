"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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
        {checks?.negative && (
          <li>
            Negative claim about {checks.negative.subject ?? "the record"} — search completeness:{" "}
            {checks.negative.basis}. {checks.negative.complete ? "" : "Findings may be incomplete."}
          </li>
        )}
        {claim.verifyError && <li>Recorded reason: {claim.verifyError}.</li>}
      </ul>
    </div>
  );
}

/* G-14: the manager's correction controls for one claim. A review excludes
   the claim from the findings, the client pack and the draft, and is kept as
   the audit trail; the report refreshes with the reviewed state. */
function ReviewControls({ claim }: { claim: Claim }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (verdict: "wrong" | "unsupported" | "out_of_scope") => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/investigations/${claim.investigationId}/claims/${claim.id}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ verdict, reason: reason.trim() || null }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Could not save the review.");
      }
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/investigations/${claim.investigationId}/claims/${claim.id}/review`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Could not clear the review.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-checks">
      <span className="now-label">Manager review</span>
      {claim.review ? (
        <>
          <span className="chip chip-broken">
            reviewed: {claim.review.verdict.replace(/_/g, " ")}
          </span>
          {claim.review.reason && <span className="small muted">{claim.review.reason}</span>}
          <span className="small muted">
            Recorded {claim.review.createdAt.slice(0, 10)} — this finding is excluded from the
            report findings and the client pack.
          </span>
          <div className="row">
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={clear}>
              Clear review
            </button>
          </div>
        </>
      ) : (
        <>
          <input
            className="input"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={busy}
          />
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={() => submit("wrong")}>
              Mark wrong
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => submit("unsupported")}
            >
              Unsupported
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => submit("out_of_scope")}
            >
              Out of scope
            </button>
          </div>
        </>
      )}
      {error && <span className="alert alert-error">{error}</span>}
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
  /** The full finding label, shown bold as the drawer's first line. */
  heading?: string;
  events: Event[];
  claims: Claim[];
  onClose: () => void;
}

export function EvidenceDrawer({ eventId, claimId, heading, events, claims, onClose }: DrawerProps) {
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const event = events.find((candidate) => candidate.id === eventId);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        onClose();
        return;
      }
      // Focus trap: claimed aria-modal focus must stay inside the drawer.
      if (keyboardEvent.key !== "Tab") return;
      const drawer = closeRef.current?.closest("aside");
      if (!drawer) return;
      const focusables = drawer.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (keyboardEvent.shiftKey && (active === first || !drawer.contains(active))) {
        keyboardEvent.preventDefault();
        last.focus();
      } else if (!keyboardEvent.shiftKey && (active === last || !drawer.contains(active))) {
        keyboardEvent.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
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
        {heading && <p className="drawer-heading">{heading}</p>}
        <div className="spread">
          <span className="small muted">
            {event.ts} · {event.actorResolved ?? event.actor} · {event.channel} · <SourceChip source={event.source} />
          </span>
          <button type="button" ref={closeRef} className="btn btn-quiet drawer-close" onClick={onClose} aria-label="Close evidence">
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
        {focusClaim && <ReviewControls claim={focusClaim} />}

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
