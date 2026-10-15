import type { Gap, SkepticNote } from "@/lib/types";

const KIND_LABEL: Record<string, string> = {
  contradiction: "possible conflict",
  unsupported: "weakly supported",
  silence: "silence in the records",
  unanswered: "no reply found",
};

const KIND_PILL: Record<string, string> = {
  contradiction: "pill-bad",
  unsupported: "pill-warn",
  silence: "pill-slack",
  unanswered: "pill-info",
};

export function GapsPanel({ gaps, notes }: { gaps: Gap[]; notes: SkepticNote[] }) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="flex flex-col gap-3">
        <h3 className="section-title">Gaps in the record</h3>
        {gaps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-muted">
            The records did not leave obvious gaps.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {gaps.map((gap) => (
              <li key={gap.id} className="flex flex-col gap-1 rounded-xl border border-line p-3">
                <p className="text-xs font-medium leading-relaxed">{gap.question}</p>
                <p className="text-xs leading-relaxed text-muted">{gap.note}</p>
                {gap.eventIds.length > 0 && (
                  <p className="flex flex-wrap gap-1">
                    {gap.eventIds.map((eventId) => (
                      <a
                        key={eventId}
                        href={`#event-${eventId}`}
                        className="pill pill-neutral text-accent"
                      >
                        view message
                      </a>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="section-title">Concerns raised</h3>
        {notes.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-muted">
            Nothing in the findings contradicted another record.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id} className="flex flex-col gap-1 rounded-xl border border-line p-3">
                <span className={`pill w-fit ${KIND_PILL[note.kind] ?? "pill-neutral"}`}>
                  {KIND_LABEL[note.kind] ?? note.kind}
                </span>
                <p className="text-xs leading-relaxed text-muted">{note.text}</p>
                {note.eventIds.length > 0 && (
                  <p className="flex flex-wrap gap-1">
                    {note.eventIds.map((eventId) => (
                      <a
                        key={eventId}
                        href={`#event-${eventId}`}
                        className="pill pill-neutral text-accent"
                      >
                        view message
                      </a>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
