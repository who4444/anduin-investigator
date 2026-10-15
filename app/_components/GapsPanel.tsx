import type { Gap, SkepticNote } from "@/lib/types";

const KIND_STYLES: Record<string, string> = {
  contradiction: "bg-red-100 text-red-800",
  unsupported: "bg-amber-100 text-amber-800",
  silence: "bg-purple-100 text-purple-800",
  unanswered: "bg-blue-100 text-blue-800",
};

export function GapsPanel({ gaps, notes }: { gaps: Gap[]; notes: SkepticNote[] }) {
  return (
    <div className="flex flex-col gap-4 text-xs">
      <section className="flex flex-col gap-2">
        <h3 className="font-semibold text-neutral-600">Gaps in the record</h3>
        {gaps.length === 0 && <p className="text-neutral-500">The records did not leave obvious gaps.</p>}
        <ul className="flex flex-col gap-2">
          {gaps.map((gap) => (
            <li key={gap.id} className="rounded border border-neutral-200 p-3">
              <p className="font-medium">{gap.question}</p>
              <p className="text-neutral-600">{gap.note}</p>
              {gap.eventIds.length > 0 && (
                <p className="mt-1 font-mono text-neutral-400">{gap.eventIds.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold text-neutral-600">Skeptic findings</h3>
        {notes.length === 0 && (
          <p className="text-neutral-500">The skeptic raised no contradictions, unsupported claims or silences.</p>
        )}
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li key={note.id} className="rounded border border-neutral-200 p-3">
              <span className={`rounded px-1 ${KIND_STYLES[note.kind] ?? "bg-neutral-100"}`}>{note.kind}</span>
              <p className="mt-1 text-neutral-700">{note.text}</p>
              {note.eventIds.length > 0 && (
                <p className="mt-1 font-mono text-neutral-400">{note.eventIds.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
