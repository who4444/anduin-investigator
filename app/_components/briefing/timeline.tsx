"use client";

import { useMemo, useState } from "react";

import { SourceIcon, StatusIcon } from "@/app/_components/icons";
import type { ReportPayload } from "@/lib/report/build";
import type { ReportFindingModel, ReportModel } from "@/lib/report/model";

/* The timeline is DOM, like the rest of the report: lanes are rows, dots are
   absolutely positioned buttons on a true linear time scale, the overlay
   (silence band, weekend shading, gridlines, connectors) is one pointer-events
   -none layer behind the dots. */

const DAY = 86_400_000;
const ROW_H = 34; // lane height (was ~48; reduced ~30%)
const LANE_LABELS: Record<string, string> = {
  ticket: "Ticket",
  owner: "Owner",
  promises: "Promises",
  client: "Client",
};

type DotStatus = "verified" | "needs_check" | "conflict" | "recorded";

const STATUS_LABEL: Record<DotStatus, string> = {
  verified: "verified",
  needs_check: "needs check",
  conflict: "conflict",
  recorded: "recorded, not judged",
};

function dotStatus(finding: ReportFindingModel): DotStatus {
  if (finding.pill === "conflict") return "conflict";
  if (finding.pill === "needs_check") return "needs_check";
  if (finding.verification === "verified") return "verified";
  return "recorded";
}

/* Narrative lane order: Ticket → Owner → Promises → Client. */
function laneFor(finding: ReportFindingModel, model: ReportModel): string {
  if (finding.kind === "promise") return "promises";
  if (finding.kind === "status_change") return "owner";
  const actor =
    model.actors.find((candidate) => candidate.id === finding.eventActorId) ??
    model.actors.find((candidate) => finding.actorIds.includes(candidate.id));
  if (actor?.role === "client") return "client";
  return "ticket";
}

function pickStep(spanDays: number): number {
  for (const step of [1, 2, 3, 7, 14, 30, 90, 180, 365]) {
    if (spanDays / step <= 6) return step;
  }
  return Math.ceil(spanDays / 6);
}

interface Tick {
  ts: number;
  label: string;
}

function buildTicks(min: number, max: number): { ticks: Tick[]; step: number } {
  const spanDays = Math.max(1, Math.round((max - min) / DAY));
  const step = pickStep(spanDays);
  const firstMidnight = Math.ceil(min / DAY) * DAY;
  const epochDays = Math.floor(firstMidnight / DAY);
  const aligned = Math.ceil(epochDays / step) * step * DAY;
  const ticks: Tick[] = [];
  for (let t = aligned; t <= max; t += step * DAY) {
    ticks.push({
      ts: t,
      label: new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    });
  }
  // Always mark the final record when the last tick is far from it.
  const last = ticks[ticks.length - 1];
  if (!last || max - last.ts > (step * DAY) / 2) {
    ticks.push({
      ts: max,
      label: new Date(max).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    });
  }
  return { ticks, step };
}

function weekendSpans(min: number, max: number): { from: number; to: number }[] {
  const spanDays = Math.round((max - min) / DAY);
  if (spanDays > 60) return [];
  const spans: { from: number; to: number }[] = [];
  let t = Math.floor(min / DAY) * DAY;
  while (t <= max) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) spans.push({ from: Math.max(t, min), to: Math.min(t + DAY, max) });
    t += DAY;
  }
  return spans;
}

export function ModelSwimlane({
  report,
  onFinding,
}: {
  report: ReportPayload;
  onFinding: (finding: ReportFindingModel) => void;
}) {
  const model = report.model;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<{ id: string; lane: string } | null>(null);

  const dated = useMemo(
    () =>
      model.findings
        .filter((finding) => Number.isFinite(Date.parse(finding.ts)))
        .sort((a, b) => (a.ts < b.ts ? -1 : 1)),
    [model.findings],
  );

  const geometry = useMemo(() => {
    if (dated.length === 0) return null;
    const times = dated.map((finding) => Date.parse(finding.ts));
    const min = Math.min(...times);
    const maxRaw = Math.max(...times, model.state.asOf ? Date.parse(model.state.asOf) : -Infinity);
    const max = Math.max(maxRaw, min + DAY);
    const span = max - min;
    const spanDays = Math.max(1, Math.round(span / DAY));
    const percent = (ts: number | string) => {
      const value = typeof ts === "number" ? ts : Date.parse(ts);
      if (!Number.isFinite(value)) return 0;
      return Math.min(100, Math.max(0, ((value - min) / span) * 100));
    };
    return { min, max, spanDays, percent, ...buildTicks(min, max) };
  }, [dated, model.state.asOf]);

  if (!geometry) return <p className="empty">No dated findings to place on the board.</p>;

  const { min, max, spanDays, percent, ticks } = geometry;
  const weekends = weekendSpans(min, max);

  const byLane = new Map<string, ReportFindingModel[]>(
    Object.keys(LANE_LABELS).map((lane) => [lane, []]),
  );
  for (const finding of dated) byLane.get(laneFor(finding, model))!.push(finding);

  /* Cluster same-day findings per lane; they open into individual dots. */
  const clusters = new Map<string, ReportFindingModel[]>();
  const singles: { finding: ReportFindingModel; lane: string }[] = [];
  for (const [lane, findings] of byLane) {
    const byDay = new Map<string, ReportFindingModel[]>();
    for (const finding of findings) {
      const day = finding.ts.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), finding]);
    }
    for (const [day, group] of byDay) {
      if (group.length >= 2) clusters.set(`${lane}:${day}`, group);
      else singles.push({ finding: group[0], lane });
    }
  }

  const findingByEvent = new Map<string, ReportFindingModel>();
  for (const finding of model.findings) {
    for (const eventId of finding.eventIds) if (!findingByEvent.has(eventId)) findingByEvent.set(eventId, finding);
  }
  const laneIndex = (lane: string) => Object.keys(LANE_LABELS).indexOf(lane);

  /* Connectors: contradiction basis pairs (real links in the data) and broken
     promises to their missed deadline. */
  const connectors: { x1: number; y1: number; x2: number; y2: number; tickX?: number }[] = [];
  for (const contradiction of model.contradictions ?? []) {
    const linked = contradiction.basis
      .map((eventId) => findingByEvent.get(eventId))
      .filter((finding): finding is ReportFindingModel => Boolean(finding));
    if (linked.length >= 2) {
      const a = linked[0];
      const b = linked[1];
      const laneA = laneFor(a, model);
      const laneB = laneFor(b, model);
      connectors.push({
        x1: percent(a.ts),
        y1: laneIndex(laneA) * ROW_H + ROW_H / 2,
        x2: percent(b.ts),
        y2: laneIndex(laneB) * ROW_H + ROW_H / 2,
      });
    }
    if (connectors.length >= 6) break;
  }
  for (const commitment of report.commitments ?? []) {
    if (connectors.length >= 6) break;
    if (commitment.status !== "broken" || !commitment.deadlineIso) continue;
    const anchor = commitment.sourceEventIds.map((eventId) => findingByEvent.get(eventId)).find(Boolean);
    if (!anchor || !anchor.eventIds.includes(commitment.sourceEventIds[0] ?? "")) continue;
    if (Date.parse(commitment.deadlineIso) < min || Date.parse(commitment.deadlineIso) > max) continue;
    const lane = laneFor(anchor, model);
    connectors.push({
      x1: percent(anchor.ts),
      y1: laneIndex(lane) * ROW_H + ROW_H / 2,
      x2: percent(commitment.deadlineIso),
      y2: laneIndex(lane) * ROW_H + ROW_H / 2,
      tickX: percent(commitment.deadlineIso),
    });
  }

  /* The one silence object: the project gap is the "no incident activity" band. */
  const band = model.silences?.project ?? null;
  const lastClient = model.state.lastClientContact;
  const daysSinceClient =
    lastClient.known && lastClient.value
      ? Math.max(0, Math.floor((max - Date.parse(lastClient.value.ts)) / DAY))
      : null;

  const tipFor = (finding: ReportFindingModel, lane: string, x: number) =>
    active && active.id === finding.id && active.lane === lane ? (
      <span
        className="tl-tip"
        role="tooltip"
        style={{ left: `${x}%` }}
        data-side={x > 72 ? "right" : x < 28 ? "left" : "mid"}
      >
        <span className="tl-tip-date mono">{finding.ts.slice(0, 10)}</span>
        <span className="tl-tip-claim">{finding.headline}</span>
        <span className="tl-tip-meta">
          <StatusIcon status={dotStatus(finding)} size={12} />
          {STATUS_LABEL[dotStatus(finding)]} · <SourceIcon source={finding.source} size={12} /> {finding.source}
        </span>
      </span>
    ) : null;

  const dot = (finding: ReportFindingModel, lane: string, offset = 0) => {
    const status = dotStatus(finding);
    const x = percent(finding.ts);
    return (
      <button
        key={finding.id}
        type="button"
        className="tl-dot"
        data-status={status}
        style={{ left: `${x}%`, transform: offset ? `translate(-50%, calc(-50% + ${offset}px))` : undefined }}
        aria-label={`${finding.ts.slice(0, 10)}, ${STATUS_LABEL[status]}, ${finding.source}: ${finding.headline}`}
        onMouseEnter={() => setActive({ id: finding.id, lane })}
        onMouseLeave={() => setActive(null)}
        onFocus={() => setActive({ id: finding.id, lane })}
        onBlur={() => setActive(null)}
        onClick={() => onFinding(finding)}
      >
        {status !== "recorded" && <StatusIcon status={status} size={9} />}
        {tipFor(finding, lane, x)}
      </button>
    );
  };

  return (
    <div className="swimlane-wrap">
      <div className="tl-scroll">
        <div className="tl">
          <div className="tl-axis">
            <span className="tl-axis-spacer" />
            <div className="tl-track tl-axis-track">
              {ticks.map((tick) => {
                const x = percent(tick.ts);
                return (
                  <span
                    key={tick.ts}
                    className="tl-tick-label mono"
                    style={{ left: `${x}%`, transform: x > 88 ? "translateX(-100%)" : undefined }}
                  >
                    {tick.label}
                  </span>
                );
              })}
              {band && (
                <span
                  className="tl-axis-band-label"
                  style={{ left: `${percent(band.from)}%` }}
                >
                  {band.days} days, no incident activity
                </span>
              )}
              <span className="tl-last mono">
                Last record {new Date(max).toISOString().slice(0, 10)}
                {daysSinceClient !== null ? ` · client silent ${daysSinceClient}d` : ""}
              </span>
            </div>
          </div>

          <div className="tl-rows">
            <div className="tl-overlay" aria-hidden>
              {weekends.map((span) => (
                <span
                  key={`w-${span.from}`}
                  className="tl-weekend"
                  style={{ left: `${percent(span.from)}%`, width: `${percent(span.to) - percent(span.from)}%` }}
                />
              ))}
              {band && (
                <span
                  className="tl-band"
                  style={{ left: `${percent(band.from)}%`, width: `${percent(band.to) - percent(band.from)}%` }}
                />
              )}
              {ticks.map((tick) => (
                <span key={`g-${tick.ts}`} className="tl-gridline" style={{ left: `${percent(tick.ts)}%` }} />
              ))}
              <svg className="tl-links" viewBox={`0 0 100 ${ROW_H * 4}`} preserveAspectRatio="none">
                {connectors.map((connector, index) => (
                  <g key={index}>
                    <line
                      x1={connector.x1}
                      y1={connector.y1}
                      x2={connector.x2}
                      y2={connector.y2}
                      className="tl-link"
                      vectorEffect="non-scaling-stroke"
                    />
                    {connector.tickX !== undefined && (
                      <line
                        x1={connector.tickX}
                        y1={connector.y2 - 6}
                        x2={connector.tickX}
                        y2={connector.y2 + 6}
                        className="tl-link"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </g>
                ))}
              </svg>
            </div>

            {Object.entries(LANE_LABELS).map(([lane, label]) => (
              <div className="tl-row" key={lane}>
                <span className="tl-lane">{label}</span>
                <div className="tl-track">
                  {singles.filter((entry) => entry.lane === lane).map((entry) => dot(entry.finding, lane))}
                  {[...clusters.entries()]
                    .filter(([key]) => key.startsWith(`${lane}:`))
                    .map(([key, group]) => {
                      const isOpen = expanded.has(key);
                      if (isOpen) {
                        return group.map((finding, index) =>
                          dot(finding, lane, (index - (group.length - 1) / 2) * 8),
                        );
                      }
                      const day = key.slice(key.indexOf(":") + 1);
                      const x = percent(`${day}T00:00:00Z`);
                      return (
                        <button
                          key={key}
                          type="button"
                          className="tl-cluster"
                          style={{ left: `${x}%` }}
                          aria-expanded={false}
                          aria-label={`${group.length} events on ${day} — expand`}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              next.add(key);
                              return next;
                            })
                          }
                          onFocus={() =>
                            setExpanded((current) => {
                              if (current.has(key)) return current;
                              const next = new Set(current);
                              next.add(key);
                              return next;
                            })
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setExpanded((current) => {
                                const next = new Set(current);
                                next.delete(key);
                                return next;
                              });
                            }
                          }}
                        >
                          <span className="tl-cluster-count mono">{group.length}</span>
                        </button>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="swimlane-legend small muted">
        <span className="legend-item">
          <StatusIcon status="verified" size={13} className="status-verified" /> verified
        </span>
        <span className="legend-item">
          <StatusIcon status="needs_check" size={13} className="status-check" /> needs check
        </span>
        <span className="legend-item">
          <StatusIcon status="conflict" size={13} className="status-conflict" /> conflict
        </span>
        <span className="legend-item">
          <StatusIcon status="recorded" size={13} /> recorded, not judged
        </span>
        <span className="legend-item">
          <span className="legend-cluster mono">3</span> cluster — open to expand
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-silence" /> no incident activity
        </span>
        {spanDays > 365 && (
          <span className="legend-item">axis spans {spanDays} days — distances are exactly proportional</span>
        )}
      </div>
    </div>
  );
}
