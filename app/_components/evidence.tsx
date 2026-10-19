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

/* A source is a stored record plus the finding label it supports. Several
   sources can sit behind one sentence — the drawer lists them, then opens one. */
export interface DrawerSource {
  eventId: string;
  claimId?: string;
  heading: string;
  verification?: "verified" | "supported" | "unverified" | "rejected";
  pill?: "needs_check" | "conflict" | null;
  /** Where in the report this record is used, for the "Used in" line. */
  usedIn?: string[];
}

const VERIFY_LABEL: Record<string, string> = {
  verified: "matches the record",
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

function humanDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function sourceLabel(source: string): string {
  if (source === "jira") return "Jira";
  if (source === "slack") return "Slack";
  if (source === "email") return "email";
  return source;
}

/* What this record can prove depends on who wrote it. A client email proves
   the client said something, not that it happened; a Jira transition is the
   ticket system itself; a vendor message is a statement, not confirmation. */
function provenanceFor(
  event: Event,
  role: "client" | "internal" | "unknown" | null,
  kind: string | null,
): string {
  const who = event.actorResolved ?? event.actor;
  if (kind === "status_change") {
    return `The ticket system itself records this change on ${humanDate(event.ts)} — it is the system of record for the ticket's status.`;
  }
  if (role === "client") {
    return `This is the client's own ${sourceLabel(event.source)} record — it shows what ${who} said on ${humanDate(event.ts)}, not independently confirmed fact.`;
  }
  if (role === "internal") {
    return `A vendor statement recorded in ${sourceLabel(event.source)} by ${who} — recorded, not independently confirmed.`;
  }
  return `The author's role is not confirmed, so treat this as a recorded statement, not confirmed fact.`;
}

function ClaimChecks({ claim }: { claim: Claim }) {
  const checks = claim.checks;
  return (
    <div className="drawer-checks">
      <span className="now-label">How this was checked</span>
      <span className={VERIFY_CLASS[claim.verifyStatus] ?? "chip"}>
        {VERIFY_LABEL[claim.verifyStatus] ?? claim.verifyStatus}
      </span>
      <ul className="check-list small">
        {checks?.quote && (
          <li>
            <strong>Quote:</strong>{" "}
            {checks.quote.ok ? "found verbatim in this stored record" : "not found in this record"}.
          </li>
        )}
        {checks?.attribution && (
          <li>
            <strong>Author and time:</strong>{" "}
            {checks.attribution.ok
              ? `match this record (${checks.attribution.eventActor}).`
              : `${ATTRIBUTION_NOTE[checks.attribution.reason ?? ""] ?? "do not match this record."} Claim said ${
                  checks.attribution.claimActor ?? "nobody"
                }; the record is by ${checks.attribution.eventActor}.`}
          </li>
        )}
        {checks?.entailment && (
          <li className="muted">
            <strong>Model second opinion:</strong>{" "}
            {ENTAILMENT_NOTE[checks.entailment.verdict] ?? checks.entailment.verdict}
            {checks.entailment.error ? ` (${checks.entailment.error})` : ""}. This is a model
            judgement — the weakest layer, not proof.
          </li>
        )}
        {checks?.negative && (
          <li>
            <strong>Negative claim</strong> about {checks.negative.subject ?? "the record"} — search
            completeness: {checks.negative.basis}. {checks.negative.complete ? "" : "Findings may be incomplete."}
          </li>
        )}
        {claim.verifyError && <li className="muted">Recorded reason: {claim.verifyError}.</li>}
      </ul>
    </div>
  );
}

/* G-14: the manager's correction controls for one claim. A review excludes
   the claim from the findings, the client pack and the draft, and is kept as
   the audit trail; the report refreshes with the reviewed state. The reason
   is required — a correction must say why. */
function ReviewControls({ claim }: { claim: Claim }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (verdict: "wrong" | "unsupported" | "out_of_scope") => {
    if (!reason.trim()) {
      setError("A reason is required when overriding or rejecting a finding.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/investigations/${claim.investigationId}/claims/${claim.id}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ verdict, reason: reason.trim() }),
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
            Recorded {humanDate(claim.review.createdAt)} — this finding is excluded from the report
            findings and the client pack.
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
            placeholder="Reason (required)"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (error) setError(null);
            }}
            disabled={busy}
            aria-label="Reason for the correction"
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
  /** One or more records behind a sentence. With more than one, the drawer
      opens as a list and each row opens the full record view. */
  sources: DrawerSource[];
  /** Open a specific claim's record directly (used by the reply sentences). */
  initialClaimId?: string;
  events: Event[];
  claims: Claim[];
  /** Resolved author roles, for the provenance line. */
  roleFor: (event: Event) => "client" | "internal" | "unknown" | null;
  /** Finding kind per event (status changes are system-of-record). */
  kindFor?: (event: Event) => string | null;
  onClose: () => void;
}

function statusPill(source: DrawerSource): { label: string; className: string } {
  if (source.pill === "conflict") return { label: "conflict", className: "chip chip-broken" };
  if (source.pill === "needs_check") return { label: "needs check", className: "chip chip-check" };
  if (source.verification === "verified") return { label: "verified", className: "chip chip-verified" };
  return { label: "recorded", className: "chip" };
}

export function EvidenceDrawer({
  sources,
  initialClaimId,
  events,
  claims,
  roleFor,
  kindFor,
  onClose,
}: DrawerProps) {
  const [copied, setCopied] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(() => {
    if (sources.length <= 1) return 0;
    const match = initialClaimId
      ? sources.findIndex((source) => source.claimId === initialClaimId)
      : -1;
    return match >= 0 ? match : null;
  });
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

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

  const source = activeIndex !== null ? sources[activeIndex] : null;
  const event = source ? events.find((candidate) => candidate.id === source.eventId) : undefined;

  const relevant = event
    ? claims.filter((claim) => claim.eventId === event.id && claim.verifyStatus !== "rejected")
    : [];
  const focusClaim = source?.claimId
    ? claims.find((claim) => claim.id === source.claimId)
    : relevant[0];
  const quotes = (focusClaim ? [focusClaim] : relevant).map((claim) => claim.quote);
  const segments = event ? highlightSegments(event.text, quotes) : [];

  const copy = async () => {
    if (!event) return;
    try {
      await navigator.clipboard.writeText(event.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied.
    }
  };

  const closeButton = (
    <button
      type="button"
      ref={closeRef}
      className="btn btn-quiet drawer-close"
      onClick={onClose}
      aria-label="Close evidence"
    >
      Close
    </button>
  );

  /* List mode: every record behind the sentence, each openable. */
  if (!source) {
    return (
      <div className="drawer-backdrop" onClick={onClose}>
        <aside
          className="drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Sources for this statement"
          onClick={(clickEvent) => clickEvent.stopPropagation()}
        >
          <div className="drawer-head">
            <span className="now-label">Sources for this statement · {sources.length}</span>
            {closeButton}
          </div>
          <ul className="drawer-source-list">
            {sources.map((entry, index) => {
              const pill = statusPill(entry);
              const entryEvent = events.find((candidate) => candidate.id === entry.eventId);
              return (
                <li key={`${entry.eventId}-${entry.claimId ?? index}`}>
                  <button
                    type="button"
                    className="drawer-source-row"
                    onClick={() => setActiveIndex(index)}
                  >
                    <span className="row">
                      {entryEvent && <SourceChip source={entryEvent.source} />}
                      <span className="small muted">
                        {entryEvent ? humanDate(entryEvent.ts) : "unknown date"}
                        {entryEvent ? ` · ${entryEvent.actorResolved ?? entryEvent.actor}` : ""}
                      </span>
                      <span className={pill.className}>{pill.label}</span>
                    </span>
                    <span className="drawer-source-label">{entry.heading}</span>
                    {entry.usedIn && entry.usedIn.length > 0 && (
                      <span className="small muted">Used in: {entry.usedIn.join(" · ")}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="drawer-backdrop" onClick={onClose}>
        <aside className="drawer" role="dialog" aria-modal="true" onClick={(clickEvent) => clickEvent.stopPropagation()}>
          <div className="drawer-head">
            <span className="now-label">Stored record</span>
            {closeButton}
          </div>
          <p className="muted small">This record is not in the stored evidence.</p>
        </aside>
      </div>
    );
  }

  const role = roleFor(event);
  const kind = kindFor ? kindFor(event) : null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Stored original message"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="drawer-head">
          {sources.length > 1 ? (
            <button type="button" className="btn btn-quiet" onClick={() => setActiveIndex(null)}>
              ← All {sources.length} sources
            </button>
          ) : (
            <span className="now-label">Stored record</span>
          )}
          {closeButton}
        </div>

        <p className="drawer-heading">{source.heading}</p>
        <p className="small muted drawer-meta">
          <SourceChip source={event.source} /> {humanDate(event.ts)} ·{" "}
          {event.actorResolved ?? event.actor} · {event.channel}
        </p>

        <div className="drawer-body">
          <p className="evidence drawer-evidence">
            {segments.map((segment, index) =>
              segment.highlighted ? (
                <mark key={index}>{segment.text}</mark>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </p>

          <p className="drawer-provenance small">
            <strong>What this record proves:</strong> {provenanceFor(event, role, kind)}
          </p>

          {focusClaim && <ClaimChecks claim={focusClaim} />}
          {focusClaim && <ReviewControls claim={focusClaim} />}

          {source.usedIn && source.usedIn.length > 0 && (
            <p className="small muted">Used in this report: {source.usedIn.join(" · ")}</p>
          )}

          {event.refs && event.refs.length > 0 && (
            <p className="small muted">Related tickets: {event.refs.join(", ")}</p>
          )}
        </div>

        <div className="drawer-actions">
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
