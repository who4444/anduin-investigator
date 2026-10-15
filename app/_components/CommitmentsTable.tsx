import type { Claim } from "@/lib/types";

const STATUS_STYLES: Record<string, string> = {
  kept: "bg-green-100 text-green-800",
  broken: "bg-red-100 text-red-800",
  unclear: "bg-amber-100 text-amber-800",
  "n/a": "bg-neutral-100 text-neutral-700",
};

export function CommitmentsTable({ ledger }: { ledger: Claim[] }) {
  if (ledger.length === 0) {
    return <p className="text-xs text-neutral-500">No verified commitments were found in the records.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-neutral-300 text-neutral-500">
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Who</th>
            <th className="py-2 pr-3 font-medium">Promise (to whom, as recorded)</th>
            <th className="py-2 pr-3 font-medium">When</th>
            <th className="py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {ledger.map((claim) => (
            <tr key={claim.id} className="border-b border-neutral-100 align-top">
              <td className="py-2 pr-3">
                <span className={`rounded px-1 ${STATUS_STYLES[claim.status] ?? "bg-neutral-100"}`}>
                  {claim.status}
                </span>
              </td>
              <td className="py-2 pr-3">{claim.actor ?? "—"}</td>
              <td className="py-2 pr-3">
                <p>{claim.text}</p>
                <p className="text-neutral-500">“{claim.quote}”</p>
              </td>
              <td className="py-2 pr-3 font-mono">{claim.ts ?? "—"}</td>
              <td className="py-2">
                <a className="text-blue-700 underline" href={`#event-${claim.eventId}`}>
                  {claim.eventId}
                </a>
                {claim.skepticFlag && <span className="ml-1 text-amber-700">⚠</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-neutral-500">
        The recipient of each promise is shown in the promise text where the records state it.
      </p>
    </div>
  );
}
