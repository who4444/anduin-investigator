import type { AssembledIdentity, AssembledStats } from "@/lib/pipeline/assemble";

interface StatsBarProps {
  stats: AssembledStats;
  eventCount: number;
  synthetic: boolean;
  cached: boolean;
  live?: boolean;
  identities: AssembledIdentity[];
}

export function StatsBar({ stats, eventCount, synthetic, cached, live, identities }: StatsBarProps) {
  const applied = identities.filter((identity) => identity.applied);
  const proposed = identities.filter((identity) => !identity.applied);

  return (
    <section className="sticky top-0 z-10 flex flex-col gap-2 rounded-xl border border-line bg-surface/95 p-3 text-xs shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        {stats.total > 0 && (
          <span className={`pill ${stats.kept === stats.total ? "pill-ok" : "pill-neutral"}`}>
            {stats.kept}/{stats.total} findings verified against their sources
          </span>
        )}
        {stats.excluded > 0 && (
          <span className="pill pill-bad" title="The quoted words could not be found in the cited message">
            {stats.excluded} could not be verified — left out
          </span>
        )}
        {stats.flagged > 0 && (
          <span className="pill pill-warn">{stats.flagged} flagged for possible conflicts</span>
        )}
        <span className="pill pill-neutral">{eventCount} events in the timeline</span>
        {synthetic && <span className="pill pill-warn">synthetic demo data</span>}
        {live && <span className="pill pill-info">pulled live</span>}
        {cached && <span className="pill pill-info">cached result</span>}
      </div>

      {identities.length > 0 && (
        <details className="text-muted">
          <summary className="cursor-pointer hover:text-ink">
            names matched across tools — {applied.length} applied, {proposed.length} suggested but not
            applied
          </summary>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-[11px]">
            {identities.map((identity, index) => (
              <li key={`${identity.alias}->${identity.canonical}-${index}`}>
                {identity.alias} → {identity.canonical}{" "}
                <span className={identity.applied ? "text-ok-fg" : "text-warn-fg"}>
                  [{identity.applied ? "applied" : "not applied"}]
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
