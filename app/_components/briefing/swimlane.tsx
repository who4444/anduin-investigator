"use client";

import { useMemo, useState } from "react";

import { PERSON_COLORS } from "@/app/_components/briefing/people";
import type { ReportPayload } from "@/lib/report/build";
import type { BriefingEvent, Lane } from "@/lib/report/briefing";

const LANE_LABEL: Record<Lane, string> = {
  client: "Client",
  promises: "Promises",
  owner: "Owner",
  ticket: "Ticket",
  engineering: "Engineering",
};

type TypeFilter = "all" | "promises" | "handoffs" | "client" | "technical";

const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "promises", label: "Promises" },
  { id: "handoffs", label: "Handoffs" },
  { id: "client", label: "Client communication" },
  { id: "technical", label: "Technical" },
];

function matchesFilter(event: BriefingEvent, filter: TypeFilter): boolean {
  switch (filter) {
    case "promises":
      return event.type === "commitment";
    case "handoffs":
      return event.lane === "owner";
    case "client":
      return event.lane === "client";
    case "technical":
      return event.type === "root_cause" || event.type === "process_failure";
    default:
      return true;
  }
}

export function SwimlaneSection({
  report,
  onClaim,
  embedded = false,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
  embedded?: boolean;
}) {
  const { briefing } = report;
  const [person, setPerson] = useState("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [hovered, setHovered] = useState<string | null>(null);

  const events = briefing.events;
  const bounds = useMemo(() => {
    const times = events.map((event) => Date.parse(event.ts)).filter((value) => Number.isFinite(value));
    if (times.length === 0) return null;
    const min = Math.min(...times);
    const max = Math.max(...times);
    return { min, max: max === min ? min + 86_400_000 : max };
  }, [events]);

  const percent = (ts: string): number => {
    if (!bounds) return 50;
    const value = Date.parse(ts);
    if (!Number.isFinite(value)) return 50;
    return Math.min(100, Math.max(0, ((value - bounds.min) / (bounds.max - bounds.min)) * 100));
  };

  const actorOptions = briefing.people.map((entry) => entry.name);

  if (!bounds || events.length === 0) {
    if (embedded) return <p className="empty">No dated events yet, so there is nothing to place on the board.</p>;
    return (
      <section className="briefing-section" id="board" aria-labelledby="board-title">
        <h2 id="board-title">Board</h2>
        <p className="empty">No dated events yet, so there is nothing to place on the board.</p>
      </section>
    );
  }

  const laneEvents = (lane: Lane) => events.filter((event) => event.lane === lane);

  const board = (
    <div className="panel stack">
      <div className="row">
        <label className="small">
          Person{" "}
          <select className="input" value={person} onChange={(event) => setPerson(event.target.value)}>
            <option value="all">everyone</option>
            {actorOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          Type{" "}
          <select
            className="input"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
          >
            {TYPE_FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="swimlane-wrap">
        <div className="swimlane">
          <div className="swimlane-axis" aria-hidden>
            <span className="swimlane-axis-spacer" />
            <div className="swimlane-axis-track">
              <span className="tabular">{bounds ? new Date(bounds.min).toISOString().slice(0, 10) : ""}</span>
              <span className="tabular">{bounds ? new Date(bounds.max).toISOString().slice(0, 10) : ""}</span>
            </div>
          </div>
          {briefing.lanes.map((lane) => (
              <div className="swimlane-row" key={lane}>
                <span className="swimlane-label">{LANE_LABEL[lane]}</span>
                <div className="swimlane-track">
                  {briefing.silences.map((silence, index) => (
                    <span
                      key={`${lane}-silence-${index}`}
                      className="silence-band"
                      style={{ left: `${percent(silence.from)}%`, width: `${percent(silence.to) - percent(silence.from)}%` }}
                      title={silence.label}
                    />
                  ))}
                  {lane === "owner" &&
                    report.lanes.flatMap((ownerLane, ownerIndex) =>
                      ownerLane.lapses.map((lapse, lapseIndex) => (
                        <span
                          key={`lapse-${ownerIndex}-${lapseIndex}`}
                          className="lapse-band"
                          style={{
                            left: `${percent(lapse.from)}%`,
                            width: `${Math.max(1, percent(lapse.to) - percent(lapse.from))}%`,
                          }}
                          title={`${ownerLane.actor}: ${lapse.days} days with no activity`}
                        />
                      )),
                    )}
                  {laneEvents(lane).map((event) => {
                    const active =
                      (person === "all" || event.actor === person) && matchesFilter(event, typeFilter);
                    const related = hovered !== null && event.actor === hovered;
                    return (
                      <button
                        key={event.id}
                        type="button"
                        className={`marker${active ? "" : " is-dimmed"}${related ? " is-related" : ""}`}
                        style={{
                          left: `${percent(event.ts)}%`,
                          background: PERSON_COLORS[event.actorColor % PERSON_COLORS.length],
                        }}
                        data-importance={event.importance}
                        data-status={event.status}
                        data-verification={event.verification}
                        onMouseEnter={() => setHovered(event.actor)}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered(event.actor)}
                        onBlur={() => setHovered(null)}
                        onClick={() => onClaim(event.claimId)}
                        title={`Day ${event.dayNumber} · ${event.actor}\n${event.headline}\n${event.ts}`}
                        aria-label={`Day ${event.dayNumber}, ${event.actor}, ${LANE_LABEL[lane]}: ${event.text}`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="swimlane-legend small muted">
          <span className="legend-item"><span className="legend-swatch legend-key" /> key moment</span>
          <span className="legend-item"><span className="legend-swatch legend-dashed" /> check before repeating</span>
          <span className="legend-item"><span className="legend-swatch legend-silence" /> silent period</span>
          {report.lanes.length > 0 && (
            <span className="legend-item"><span className="legend-swatch legend-lapse" /> ownerless stretch</span>
          )}
          <span className="legend-item">hovering highlights one person&apos;s markers</span>
        </div>
      </div>
  );

  if (embedded) return board;
  return (
    <section className="briefing-section" id="board" aria-labelledby="board-title">
      <h2 id="board-title">Board</h2>
      {board}
    </section>
  );
}
