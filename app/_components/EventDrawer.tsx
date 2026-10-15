"use client";

import { highlightSegments } from "@/lib/highlight";
import type { Claim, Event } from "@/lib/types";

interface EventDrawerProps {
  event: Event;
  claims: Claim[];
  onClose: () => void;
}

const STATUS_STYLES: Record<string, string> = {
  kept: "bg-green-100 text-green-800",
  broken: "bg-red-100 text-red-800",
  unclear: "bg-amber-100 text-amber-800",
  "n/a": "bg-neutral-100 text-neutral-700",
};

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "High";
  if (confidence >= 0.5) return "Med";
  return "Low";
}

export function EventDrawer({ event, claims, onClose }: EventDrawerProps) {
  const segments = highlightSegments(
    event.text,
    claims.filter((claim) => claim.verifyStatus !== "excluded").map((claim) => claim.quote),
  );

  return (
    <div className="fixed inset-0 z-10 flex justify-end bg-black/20" role="dialog" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col gap-4 overflow-y-auto bg-white p-5 shadow-xl"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">
              {event.ts} · {event.source} · {event.channel} · {event.actorResolved ?? event.actor}
            </span>
            <span className="text-xs text-neutral-400">{event.id}</span>
          </div>
          <button type="button" className="text-sm text-neutral-500" onClick={onClose}>
            close
          </button>
        </header>

        <p className="whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-3 text-sm">
          {segments.map((segment, index) =>
            segment.highlighted ? (
              <mark key={index} className="bg-yellow-200">
                {segment.text}
              </mark>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </p>

        {event.url && (
          <a className="text-xs text-blue-700 underline" href={event.url} target="_blank" rel="noreferrer">
            open original
          </a>
        )}

        {event.refs && event.refs.length > 0 && (
          <p className="flex flex-wrap items-center gap-1 text-xs text-neutral-500">
            references:
            {event.refs.map((ref) => (
              <span key={ref} className="rounded bg-neutral-100 px-1 font-mono">
                {ref}
              </span>
            ))}
          </p>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold">Claims citing this event</h3>
          {claims.length === 0 && <p className="text-xs text-neutral-500">No claims cite this event.</p>}
          {claims.map((claim) => (
            <article key={claim.id} className="flex flex-col gap-1 rounded border border-neutral-200 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded px-1 ${STATUS_STYLES[claim.status] ?? "bg-neutral-100"}`}>
                  {claim.status}
                </span>
                <span className="text-neutral-500">{claim.type}</span>
                <span className="text-neutral-500">confidence {confidenceLabel(claim.confidence)}</span>
                {claim.skepticFlag && <span className="text-amber-700">⚠ skeptic</span>}
                {claim.verifyStatus === "excluded" && (
                  <span className="rounded bg-red-100 px-1 text-red-800">
                    failed verification — excluded
                  </span>
                )}
                {claim.verifyStatus === "unverified" && (
                  <span className="rounded bg-neutral-100 px-1 text-neutral-600">unverified</span>
                )}
              </div>
              <p className="text-sm">{claim.text}</p>
              <p className="text-xs text-neutral-500">“{claim.quote}”</p>
            </article>
          ))}
        </section>
      </aside>
    </div>
  );
}
