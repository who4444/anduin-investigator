"use client";

import { useMemo, useState } from "react";

import { EventDrawer } from "@/app/_components/EventDrawer";
import { compactEvent } from "@/lib/agents/summary";
import type { Claim, Event } from "@/lib/types";

interface TimelineProps {
  timeline: Event[];
  claims: Claim[];
}

const SOURCE_STYLES: Record<string, string> = {
  jira: "bg-blue-100 text-blue-800",
  email: "bg-amber-100 text-amber-800",
  slack: "bg-purple-100 text-purple-800",
};

export function Timeline({ timeline, claims }: TimelineProps) {
  const [actor, setActor] = useState("all");
  const [source, setSource] = useState("all");
  const [commitmentsOnly, setCommitmentsOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const actors = useMemo(
    () => Array.from(new Set(timeline.map((event) => event.actorResolved ?? event.actor))).sort(),
    [timeline],
  );
  const sources = useMemo(() => Array.from(new Set(timeline.map((event) => event.source))).sort(), [timeline]);

  const committedEventIds = useMemo(
    () => new Set(claims.filter((claim) => claim.type === "commitment").map((claim) => claim.eventId)),
    [claims],
  );

  const visible = timeline.filter((event) => {
    const eventActor = event.actorResolved ?? event.actor;
    if (actor !== "all" && eventActor !== actor) return false;
    if (source !== "all" && event.source !== source) return false;
    if (commitmentsOnly && !committedEventIds.has(event.id)) return false;
    return true;
  });

  const selected = timeline.find((event) => event.id === selectedId) ?? null;
  const selectedClaims = selected ? claims.filter((claim) => claim.eventId === selected.id) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          Person
          <select
            className="rounded border border-neutral-300 px-1 py-0.5"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
          >
            <option value="all">all</option>
            {actors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Source
          <select
            className="rounded border border-neutral-300 px-1 py-0.5"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="all">all</option>
            {sources.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={commitmentsOnly}
            onChange={(event) => setCommitmentsOnly(event.target.checked)}
          />
          commitments only
        </label>
        <span className="text-neutral-500">
          {visible.length} of {timeline.length} events
        </span>
      </div>

      <ul className="flex flex-col divide-y divide-neutral-200 rounded border border-neutral-200">
        {visible.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-neutral-50"
              onClick={() => setSelectedId(event.id)}
            >
              <span className="w-40 shrink-0 font-mono text-xs text-neutral-500">{event.ts}</span>
              <span className="w-32 shrink-0 truncate text-xs">{event.actorResolved ?? event.actor}</span>
              <span
                className={`w-14 shrink-0 rounded px-1 text-center text-xs ${
                  SOURCE_STYLES[event.source] ?? "bg-neutral-100 text-neutral-700"
                }`}
              >
                {event.source}
              </span>
              <span className="flex-1 text-xs text-neutral-700">{compactEvent(event, 140).text}</span>
            </button>
          </li>
        ))}
        {visible.length === 0 && <li className="px-3 py-4 text-xs text-neutral-500">No events match these filters.</li>}
      </ul>

      {selected && (
        <EventDrawer
          event={selected}
          claims={selectedClaims}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
