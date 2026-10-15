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
  const verifiedPct = stats.total > 0 ? Math.round((stats.kept / stats.total) * 100) : 0;

  return (
    <section className="sticky top-0 z-10 flex flex-col gap-2 rounded-xl border border-line bg-surface/95 p-3 text-xs shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`pill ${stats.kept === stats.total && stats.total > 0 ? "pill-ok" : "pill-neutral"}`}>
          {stats.kept}/{stats.total} claims verified ({verifiedPct}%)
        </span>
        <span className={`pill ${stats.excluded > 0 ? "pill-bad" : "pill-neutral"}`}>
          {stats.excluded} excluded
        </span>
        <span className={`pill ${stats.flagged > 0 ? "pill-warn" : "pill-neutral"}`}>
          {stats.flagged} flagged by skeptic
        </span>
        <span className="pill pill-neutral">{eventCount} events</span>
        {synthetic && <span className="pill pill-warn">synthetic demo data</span>}
        {live && <span className="pill pill-info">live pull</span>}
        {cached && <span className="pill pill-info">cached run</span>}
      </div>

      {identities.length > 0 && (
        <details className="text-muted">
          <summary className="cursor-pointer hover:text-ink">
            identity resolution — {applied.length} applied, {proposed.length} suggested but not applied
          </summary>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-[11px]">
            {identities.map((identity, index) => (
              <li key={`${identity.alias}->${identity.canonical}-${index}`}>
                {identity.alias} → {identity.canonical}{" "}
                <span className={identity.applied ? "text-ok-fg" : "text-warn-fg"}>
                  [{identity.method}
                  {identity.applied ? "" : ", not applied"}]
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
