import type { CoverageReport } from "@/lib/pipeline/coverage";

const SOURCE_LABEL: Record<string, string> = {
  jira: "Jira",
  email: "Email",
  slack: "Slack",
};

export function CoveragePanel({ coverage }: { coverage: CoverageReport }) {
  return (
    <div className="flex flex-col gap-3 text-xs">
      {coverage.neverSearched.length > 0 && (
        <p className="callout callout-warn">
          Available but never searched: {coverage.neverSearched.map((kind) => SOURCE_LABEL[kind] ?? kind).join(", ")} —
          findings may be incomplete.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {coverage.sources.map((entry) => (
          <li key={entry.source} className="flex flex-col gap-1 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{SOURCE_LABEL[entry.source] ?? entry.source}</span>
              <span className="pill pill-neutral">{entry.available} items</span>
              {entry.available === 0 ? (
                <span className="pill pill-neutral">no data</span>
              ) : entry.searched ? (
                <span className="pill pill-ok">searched</span>
              ) : (
                <span className="pill pill-warn">never searched</span>
              )}
            </div>
            {entry.queries.length > 0 && (
              <p className="flex flex-wrap gap-1">
                {entry.queries.map((query) => (
                  <span key={query} className="pill pill-neutral font-mono">
                    {query}
                  </span>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
