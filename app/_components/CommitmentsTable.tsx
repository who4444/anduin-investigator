import type { Claim } from "@/lib/types";

const STATUS_PILL: Record<string, string> = {
  kept: "pill-ok",
  broken: "pill-bad",
  unclear: "pill-warn",
  "n/a": "pill-neutral",
};

export function CommitmentsTable({ ledger }: { ledger: Claim[] }) {
  if (ledger.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs text-muted">
        No verified commitments were found in the records.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 overflow-x-auto">
      <table className="table min-w-[42rem]">
        <thead>
          <tr>
            <th className="w-24">Status</th>
            <th className="w-40">Who</th>
            <th>Promise (to whom, as recorded)</th>
            <th className="w-44">When</th>
            <th className="w-32">Source</th>
          </tr>
        </thead>
        <tbody>
          {ledger.map((claim) => (
            <tr key={claim.id}>
              <td>
                <span className={`pill ${STATUS_PILL[claim.status] ?? "pill-neutral"}`}>{claim.status}</span>
              </td>
              <td className="text-xs font-medium">{claim.actor ?? "—"}</td>
              <td className="text-xs">
                <p className="leading-relaxed text-ink">{claim.text}</p>
                <p className="mt-0.5 leading-relaxed text-muted">“{claim.quote}”</p>
              </td>
              <td className="font-mono text-[11px] text-muted">{claim.ts ?? "—"}</td>
              <td className="text-xs">
                <a className="font-mono text-accent underline decoration-dotted" href={`#event-${claim.eventId}`}>
                  {claim.eventId}
                </a>
                {claim.skepticFlag && <span className="ml-1" title="flagged by the skeptic">⚠</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        The recipient of each promise is shown in the promise text where the records state it.
      </p>
    </div>
  );
}
