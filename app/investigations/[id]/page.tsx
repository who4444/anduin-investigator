import Link from "next/link";
import { notFound } from "next/navigation";

import { CommitmentsTable } from "@/app/_components/CommitmentsTable";
import { GapsPanel } from "@/app/_components/GapsPanel";
import { StatsBar } from "@/app/_components/StatsBar";
import { Timeline } from "@/app/_components/Timeline";
import { buildResult } from "@/lib/pipeline/assemble";

export const dynamic = "force-dynamic";

export default async function InvestigationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  let result;
  try {
    result = await buildResult(id);
  } catch {
    notFound();
  }

  return (
    <div className="shell flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link href="/" className="text-xs text-muted hover:text-ink">
          ← New investigation
        </Link>
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {result.investigation.title}
          </h1>
          <p className="hint font-mono">{result.investigation.id}</p>
        </div>
        {result.investigation.escalationText && (
          <blockquote className="border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-muted">
            {result.investigation.escalationText}
          </blockquote>
        )}
      </div>

      <StatsBar
        stats={result.stats}
        eventCount={result.timeline.length}
        synthetic={query.synthetic === "1"}
        cached={query.cached === "1"}
        identities={result.identities}
      />

      <section className="card flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Timeline</h2>
          <span className="hint">chronological, all sources</span>
        </div>
        <Timeline timeline={result.timeline} claims={result.claims} />
      </section>

      <section className="card flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Commitments ledger</h2>
          <span className="hint">promised vs delivered</span>
        </div>
        <CommitmentsTable ledger={result.ledger} />
      </section>

      <section className="card flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">What we could not determine</h2>
          <span className="hint">never guessed</span>
        </div>
        <GapsPanel gaps={result.gaps} notes={result.skepticNotes} />
      </section>
    </div>
  );
}
