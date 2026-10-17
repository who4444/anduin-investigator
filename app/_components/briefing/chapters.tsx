"use client";

import { useState } from "react";

import { EventRow } from "@/app/_components/briefing/story";
import type { ReportPayload } from "@/lib/report/build";

export function ChaptersList({
  report,
  onClaim,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
}) {
  const { briefing } = report;
  const eventById = new Map(briefing.events.map((event) => [event.id, event]));
  const [openRoutine, setOpenRoutine] = useState<Record<string, boolean>>({});
  const [openChapter, setOpenChapter] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    briefing.chapters.forEach((chapter, index) => {
      initial[chapter.id] = index === 0;
    });
    return initial;
  });

  if (briefing.chapters.length === 0) {
    return (
      <p className="empty">
        No verified events to group yet. Run the investigation to produce the story.
      </p>
    );
  }

  return (
    <div className="chapters">
      {briefing.chapters.map((chapter) => {
        const events = chapter.eventIds
          .map((id) => eventById.get(id))
          .filter((event): event is NonNullable<typeof event> => Boolean(event))
          .sort((a, b) => (a.ts < b.ts ? -1 : 1));
        const routine = events.filter((event) => event.importance === "routine");
        const main = events.filter((event) => event.importance !== "routine");
        const isOpen = openChapter[chapter.id] ?? false;
        const showRoutine = openRoutine[chapter.id] ?? false;

        return (
          <details
            className="chapter"
            key={chapter.id}
            open={isOpen}
            onToggle={(toggleEvent) =>
              setOpenChapter((current) => ({
                ...current,
                [chapter.id]: (toggleEvent.target as HTMLDetailsElement).open,
              }))
            }
          >
            <summary>
              <span className="chapter-title">{chapter.title}</span>
              <span className="chapter-range">
                {chapter.from.slice(0, 10)} → {chapter.to.slice(0, 10)}
              </span>
              <span className="chapter-takeaway judgment" title="System summary">
                {chapter.takeaway}
              </span>
            </summary>
            <div className="chapter-events">
              {main.map((event) => (
                <EventRow key={event.id} event={event} onClaim={onClaim} />
              ))}
              {routine.length > 0 && (
                <>
                  <button
                    type="button"
                    className="routine-count"
                    aria-expanded={showRoutine}
                    onClick={() => setOpenRoutine((current) => ({ ...current, [chapter.id]: !showRoutine }))}
                  >
                    {showRoutine ? "Hide" : "Show"} {routine.length} routine update
                    {routine.length === 1 ? "" : "s"}
                  </button>
                  {showRoutine &&
                    routine.map((event) => (
                      <EventRow key={event.id} event={event} onClaim={onClaim} />
                    ))}
                </>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
