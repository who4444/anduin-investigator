"use client";

import { useEffect, useState } from "react";

import { highlightSegments } from "@/lib/highlight";
import type { Claim, Event } from "@/lib/types";

interface EventDrawerProps {
  event: Event;
  claims: Claim[];
  onClose: () => void;
}

const STATUS_PILL: Record<string, string> = {
  kept: "pill-ok",
  broken: "pill-bad",
  unclear: "pill-warn",
  "n/a": "pill-neutral",
};

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

export function EventDrawer({ event, claims, onClose }: EventDrawerProps) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const segments = highlightSegments(
    event.text,
    claims.filter((claim) => claim.verifyStatus !== "excluded").map((claim) => claim.quote),
  );

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard access can be denied; nothing to do.
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/30 p-0 sm:p-3" role="presentation" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Event detail"
        className="flex h-full w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-none border-l border-line bg-surface p-5 shadow-2xl sm:rounded-xl sm:border"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`pill ${event.source === "jira" ? "pill-info" : event.source === "email" ? "pill-warn" : "pill-slack"}`}>
                {event.source}
              </span>
              <span className="font-mono text-muted">{event.ts}</span>
              <span className="text-ink">{event.actorResolved ?? event.actor}</span>
              <span className="font-mono text-muted">{event.channel}</span>
            </span>
            <span className="font-mono text-[11px] text-muted">{event.id}</span>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-2">
          <p className="whitespace-pre-wrap rounded-xl border border-line bg-surface-2 p-3 text-sm leading-relaxed">
            {segments.map((segment, index) =>
              segment.highlighted ? (
                <mark key={index} className="mark">
                  {segment.text}
                </mark>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => copy("event", event.text)}>
              {copied === "event" ? "copied" : "Copy text"}
            </button>
            {event.url && (
              <a className="btn btn-secondary" href={event.url} target="_blank" rel="noreferrer">
                Open original ↗
              </a>
            )}
          </div>
        </div>

        {event.refs && event.refs.length > 0 && (
          <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
            references:
            {event.refs.map((ref) => (
              <span key={ref} className="pill pill-neutral font-mono">
                {ref}
              </span>
            ))}
          </p>
        )}

        <section className="flex flex-col gap-3">
          <h3 className="section-title">Claims citing this event</h3>
          {claims.length === 0 && <p className="hint">No claims cite this event.</p>}
          {claims.map((claim) => (
            <article
              key={claim.id}
              className={`flex flex-col gap-2 rounded-xl border p-3 ${
                claim.verifyStatus === "excluded" ? "border-bad-fg/40 bg-bad-bg/40" : "border-line"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`pill ${STATUS_PILL[claim.status] ?? "pill-neutral"}`}>{claim.status}</span>
                <span className="pill pill-neutral">{claim.type}</span>
                <span className="hint">agent: {claim.agent}</span>
                <span className="hint">confidence: {confidenceLabel(claim.confidence)}</span>
                {claim.skepticFlag && <span className="pill pill-warn">⚠ skeptic</span>}
              </div>
              <p className="text-sm leading-relaxed">{claim.text}</p>
              <div className="flex items-start gap-2">
                <p className="flex-1 text-xs leading-relaxed text-muted">“{claim.quote}”</p>
                <button
                  type="button"
                  className="btn btn-ghost text-[11px]"
                  onClick={() => copy(claim.id, claim.quote)}
                >
                  {copied === claim.id ? "copied" : "copy"}
                </button>
              </div>
              {claim.verifyStatus === "excluded" ? (
                <p className="pill pill-bad w-fit">
                  failed verification{claim.verifyError ? ` · ${claim.verifyError}` : ""} — excluded
                </p>
              ) : claim.verifyStatus === "unverified" ? (
                <p className="pill pill-neutral w-fit">not verified yet</p>
              ) : (
                <p className="pill pill-ok w-fit">quote verified</p>
              )}
            </article>
          ))}
        </section>
      </aside>
    </div>
  );
}
