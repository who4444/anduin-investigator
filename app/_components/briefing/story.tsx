"use client";

import { Avatar, colorFor } from "@/app/_components/briefing/people";
import { VerificationChip } from "@/app/_components/evidence";
import type { BriefingEvent, KeyMoment } from "@/lib/report/briefing";

const TAG_LABEL: Record<string, string> = {
  technical: "technical",
  process: "process",
  communication: "communication",
};

function exact(ts: string): string {
  return ts;
}

export function MomentsStrip({
  moments,
  people,
  onClaim,
}: {
  moments: KeyMoment[];
  people: import("@/lib/report/briefing").Person[];
  onClaim: (claimId: string) => void;
}) {
  return (
    <div className="moment-strip" role="list" aria-label="Key moments">
      {moments.map((moment) => (
        <button
          key={moment.id}
          type="button"
          className="moment-card"
          data-tag={moment.tag}
          role="listitem"
          onClick={() => onClaim(moment.claimId)}
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
                <Avatar name={name} colorIndex={colorFor(people, name)} />
                <span className="person-role">{roleFor(people, name)}</span>
              </span>
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}

function roleFor(people: import("@/lib/report/briefing").Person[], name: string): string | undefined {
  return people.find((person) => person.name === name)?.role;
}

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
          <span className={`source-label source-${event.source}`}>{event.source}</span>
          {event.sourceCount > 1 && (
            <span className="chip" title={`Stated in ${event.sourceCount} source records`}>
              {event.sourceCount} sources
            </span>
          )}
          {event.contested && (
            <span className="chip chip-flag" title="The merged sources disagree on the outcome">
              contested
            </span>
          )}
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
