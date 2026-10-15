"use client";

import { useMemo, useState } from "react";

import { EventDrawer } from "@/app/_components/EventDrawer";
import type { Claim, Event } from "@/lib/types";

interface TimelineProps {
  timeline: Event[];
  claims: Claim[];
}

const SOURCE_PILL: Record<string, string> = {
  jira: "pill-info",
  email: "pill-warn",
  slack: "pill-slack",
};

function preview(text: string, limit = 130): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function Timeline({ timeline, claims }: TimelineProps) {
  const [actor, setActor] = useState("all");
  const [channel, setChannel] = useState("all");
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [commitmentsOnly, setCommitmentsOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const actors = useMemo(
    () => Array.from(new Set(timeline.map((event) => event.actorResolved ?? event.actor))).sort(),
    [timeline],
  );
  const channels = useMemo(
    () => Array.from(new Set(timeline.map((event) => event.channel))).sort(),
    [timeline],
  );
  const sources = useMemo(
    () => Array.from(new Set(timeline.map((event) => event.source))).sort(),
    [timeline],
  );
  const committedEventIds = useMemo(
    () =>
      new Set(
        claims
          .filter((claim) => claim.type === "commitment" && claim.verifyStatus !== "excluded")
          .map((claim) => claim.eventId),
      ),
    [claims],
  );

  const needle = query.trim().toLowerCase();
  const visible = timeline.filter((event) => {
    const eventActor = event.actorResolved ?? event.actor;
    if (actor !== "all" && eventActor !== actor) return false;
    if (channel !== "all" && event.channel !== channel) return false;
    if (source !== "all" && event.source !== source) return false;
    if (commitmentsOnly && !committedEventIds.has(event.id)) return false;
    if (needle && !event.text.toLowerCase().includes(needle)) return false;
    return true;
  });

  const filtered =
    actor !== "all" || channel !== "all" || source !== "all" || commitmentsOnly || needle.length > 0;
  const selected = timeline.find((event) => event.id === selectedId) ?? null;
  const selectedClaims = selected ? claims.filter((claim) => claim.eventId === selected.id) : [];

  const clear = () => {
    setActor("all");
    setChannel("all");
    setSource("all");
    setQuery("");
    setCommitmentsOnly(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="hint">Search text</span>
          <input
            className="select w-48"
            placeholder="filter events…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="hint">Person</span>
          <select className="select" value={actor} onChange={(event) => setActor(event.target.value)}>
            <option value="all">all</option>
            {actors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="hint">Channel</span>
          <select className="select" value={channel} onChange={(event) => setChannel(event.target.value)}>
            <option value="all">all</option>
            {channels.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="hint">Source</span>
          <select className="select" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">all</option>
            {sources.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs">
          <input
            type="checkbox"
            checked={commitmentsOnly}
            onChange={(event) => setCommitmentsOnly(event.target.checked)}
          />
          commitments only
        </label>
        {filtered && (
          <button type="button" className="btn btn-ghost mb-1" onClick={clear}>
            clear filters
          </button>
        )}
        <span className="hint ml-auto pb-2">
          {visible.length} of {timeline.length} events
        </span>
      </div>

      <ol className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
        {visible.map((event) => {
          const isSelected = event.id === selectedId;
          return (
            <li key={event.id} id={`event-${event.id}`} className="scroll-mt-4">
              <button
                type="button"
                aria-current={isSelected}
                className={`grid w-full grid-cols-[7.5rem_1fr] items-start gap-x-3 gap-y-1 px-3 py-2.5 text-left transition-colors sm:grid-cols-[11rem_9rem_5.5rem_1fr] ${
                  isSelected ? "bg-surface-2" : "hover:bg-surface-2"
                }`}
                onClick={() => setSelectedId(event.id)}
              >
                <span className="font-mono text-[11px] text-muted">{event.ts}</span>
                <span className="truncate text-xs font-medium">{event.actorResolved ?? event.actor}</span>
                <span className="hidden sm:block">
                  <span className={`pill ${SOURCE_PILL[event.source] ?? "pill-neutral"}`}>
                    {event.source}
                  </span>
                </span>
                <span className="col-span-2 text-xs text-muted sm:col-span-1">
                  <span className="mr-2 hidden font-mono text-[11px] sm:inline">{event.channel}</span>
                  {preview(event.text)}
                </span>
              </button>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="px-3 py-8 text-center text-xs text-muted">No events match these filters.</li>
        )}
      </ol>

      {selected && (
        <EventDrawer event={selected} claims={selectedClaims} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
