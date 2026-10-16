"use client";

import { Avatar, colorFor, roleFor } from "@/app/_components/briefing/people";
import { VerificationChip } from "@/app/_components/evidence";
import type { Metric, ReportPayload } from "@/lib/report/build";
import type { BriefingEvent, KeyMoment } from "@/lib/report/briefing";

const TAG_LABEL: Record<string, string> = {
  technical: "technical",
  process: "process",
  communication: "communication",
};

function exact(ts: string): string {
  return ts;
}

export function StorySection({
  report,
  onClaim,
  onEvent,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
  onEvent: (eventId: string) => void;
}) {
  const { briefing } = report;
  const openMoment = (moment: KeyMoment) => onClaim(moment.claimId);
  const openMetric = (metric: Metric) => {
    if (metric.claimIds.length > 0) onClaim(metric.claimIds[0]);
    else if (metric.eventIds.length > 0) onEvent(metric.eventIds[0]);
  };

  return (
    <section className="briefing-section" id="story" aria-labelledby="story-title">
      <h2 id="story-title">The story</h2>
      <div className="stack">
        <p className="section-lede">{briefing.narrative ?? "No narrative has been produced yet."}</p>
        <p className="small muted">
          Verification: {briefing.confidence.verified} of {briefing.confidence.total} claims verified
          end-to-end
          {briefing.confidence.supported > 0
            ? ` · ${briefing.confidence.supported} check before repeating`
            : ""}
          {briefing.confidence.rejected > 0 ? ` · ${briefing.confidence.rejected} rejected` : ""}
          {briefing.confidence.flagged > 0
            ? ` · ${briefing.confidence.flagged} flagged in skeptic review`
            : ""}
          .
        </p>

        {briefing.keyMoments.length > 0 && (
          <div className="moment-strip" role="list" aria-label="Key moments">
            {briefing.keyMoments.map((moment) => (
              <button
                key={moment.id}
                type="button"
                className="moment-card"
                data-tag={moment.tag}
                role="listitem"
                onClick={() => openMoment(moment)}
                aria-label={`Key moment: ${moment.headline}`}
              >
                <span className="moment-date" title={exact(moment.date)}>
                  {moment.date}
                </span>
                <span className="moment-headline">{moment.headline}</span>
                <span className="event-chips">
                  <span className="chip judgment" title="System classification">
                    {TAG_LABEL[moment.tag] ?? moment.tag}
                  </span>
                  <VerificationChip verification={moment.verification} />
                  {moment.people.map((name) => (
                    <span className="person" key={name}>
                      <Avatar name={name} colorIndex={colorFor(briefing.people, name)} />
                      <span className="person-role">{roleFor(briefing.people, name)}</span>
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="metrics">
          {report.metrics.map((metric) => (
            <button
              key={metric.id}
              type="button"
              className="metric"
              onClick={() => openMetric(metric)}
              disabled={metric.claimIds.length === 0 && metric.eventIds.length === 0}
              aria-label={`${metric.label}: ${metric.value}`}
            >
              <span className="metric-value">{metric.value}</span>
              <span className="metric-label judgment" title="System classification">
                {metric.label}
              </span>
              {metric.detail && <span className="small muted">{metric.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

const SOURCE_CLASS: Record<string, string> = {
  jira: "chip chip-source-jira",
  email: "chip chip-source-email",
  slack: "chip chip-source-slack",
};

const TYPE_LABEL: Record<string, string> = {
  commitment: "promise",
  root_cause: "cause",
  process_failure: "process issue",
  decision: "decision",
  ownership: "ownership",
};

export function EventRow({
  event,
  onClaim,
}: {
  event: BriefingEvent;
  onClaim: (claimId: string) => void;
}) {
  return (
    <button
      type="button"
      className="event-row"
      data-importance={event.importance}
      onClick={() => onClaim(event.claimId)}
      title={exact(event.ts)}
      aria-label={`Day ${event.dayNumber}, ${event.actor}: ${event.text}`}
    >
      <span className="event-day">Day {event.dayNumber}</span>
      <Avatar name={event.actor} colorIndex={event.actorColor} />
      <span>
        <span className="event-headline">{event.headline}</span>
        <span className="event-chips">
          <span className="person">
            <span className="person-role">{event.actorRole}</span>
          </span>
          <span className={SOURCE_CLASS[event.source] ?? "chip"}>{event.source}</span>
          <span className="chip judgment" title="System classification">
            {TYPE_LABEL[event.type] ?? event.type}
          </span>
          {event.status !== "n/a" && (
            <span className={`chip ${event.status === "broken" ? "chip-broken" : event.status === "kept" ? "chip-verified" : "chip-unclear"}`}>
              {event.status}
            </span>
          )}
          {event.flagged && (
            <span className="chip chip-flag" title="Flagged in skeptic review">
              possible conflict
            </span>
          )}
          <VerificationChip verification={event.verification} />
        </span>
      </span>
    </button>
  );
}
