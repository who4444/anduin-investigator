import { notFound } from "next/navigation";

import { buildResult } from "@/lib/pipeline/assemble";
import { CommitmentsTable } from "@/app/_components/CommitmentsTable";
import { GapsPanel } from "@/app/_components/GapsPanel";
import { StatsBar } from "@/app/_components/StatsBar";
import { Timeline } from "@/app/_components/Timeline";

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
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{result.investigation.title}</h1>
        {result.investigation.escalationText && (
          <p className="max-w-3xl text-sm text-neutral-600">{result.investigation.escalationText}</p>
        )}
      </header>

      <StatsBar
        stats={result.stats}
        eventCount={result.timeline.length}
        synthetic={query.synthetic === "1"}
        cached={query.cached === "1"}
        identities={result.identities}
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Timeline</h2>
        <Timeline timeline={result.timeline} claims={result.claims} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Commitments ledger</h2>
        <CommitmentsTable ledger={result.ledger} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">What we could not determine</h2>
        <GapsPanel gaps={result.gaps} notes={result.skepticNotes} />
      </section>
    </main>
  );
}
