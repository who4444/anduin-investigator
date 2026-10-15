import type { AssembledIdentity, AssembledStats } from "@/lib/pipeline/assemble";

interface StatsBarProps {
  stats: AssembledStats;
  eventCount: number;
  synthetic: boolean;
  cached: boolean;
  identities: AssembledIdentity[];
}

export function StatsBar({ stats, eventCount, synthetic, cached, identities }: StatsBarProps) {
  const applied = identities.filter((identity) => identity.applied);
  const proposed = identities.filter((identity) => !identity.applied);

  return (
    <section className="flex flex-col gap-2 rounded border border-neutral-200 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded bg-neutral-100 px-2 py-0.5">
          {stats.kept}/{stats.total} claims verified
        </span>
        <span className={`rounded px-2 py-0.5 ${stats.excluded > 0 ? "bg-red-100 text-red-800" : "bg-neutral-100"}`}>
          {stats.excluded} excluded
        </span>
        <span
          className={`rounded px-2 py-0.5 ${stats.flagged > 0 ? "bg-amber-100 text-amber-800" : "bg-neutral-100"}`}
        >
          {stats.flagged} flagged by skeptic
        </span>
        <span className="text-neutral-500">{eventCount} events in the timeline</span>
        {synthetic && <span className="rounded bg-amber-200 px-2 py-0.5 text-amber-900">synthetic demo data</span>}
        {cached && <span className="rounded bg-neutral-200 px-2 py-0.5">cached run</span>}
      </div>

      {identities.length > 0 && (
        <details className="text-neutral-600">
          <summary className="cursor-pointer">
            identity resolution ({applied.length} applied, {proposed.length} proposed)
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono">
            {identities.map((identity, index) => (
              <li key={`${identity.alias}->${identity.canonical}-${index}`}>
                {identity.alias} → {identity.canonical} [{identity.method}
                {identity.applied ? "" : ", not applied"}]
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
