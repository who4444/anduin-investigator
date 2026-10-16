import { notFound } from "next/navigation";

import { BriefingShell } from "@/app/_components/briefing/shell";
import { buildResult } from "@/lib/pipeline/assemble";
import { buildBriefing } from "@/lib/report/briefing";
import { buildReportView, type ReportPayload } from "@/lib/report/build";
import { getReportExtras } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  let report: ReportPayload;
  try {
    const assembled = await buildResult(id);    const extras = await getReportExtras(id);
    report = {
      investigation: {
        id: assembled.investigation.id,
        title: assembled.investigation.title,
        escalationText: assembled.investigation.escalationText,
        createdAt: assembled.investigation.createdAt,
      },
      events: assembled.timeline,
      claims: assembled.claims,
      stats: assembled.stats,
      stages: assembled.stages,
      coverage: assembled.coverage,
      gaps: assembled.gaps,
      skepticNotes: assembled.skepticNotes,
      verdict: extras?.verdict ?? null,
      reply: extras?.reply ?? null,
      ...buildReportView({
        events: assembled.timeline,
        claims: assembled.claims,
        notes: assembled.skepticNotes,
      }),
      briefing: buildBriefing({
        events: assembled.timeline,
        claims: assembled.claims,
      }),
    };
  } catch (error) {
    // Only a genuinely unknown investigation is a 404; anything else (database
    // outage, partial pipeline state) must not masquerade as a missing page.
    if (error instanceof Error && /^No investigation with id /.test(error.message)) notFound();
    throw error;
  }

  const flags = new URLSearchParams();
  if (query.synthetic === "1") flags.set("synthetic", "1");
  if (query.live === "1") flags.set("live", "1");
  if (query.cached === "1") flags.set("cached", "1");
  const suffix = flags.toString();
  const progressHref = `/investigations/${id}/progress?review=1${suffix ? `&${suffix}` : ""}`;

  return (
    <BriefingShell
      report={report}
      progressHref={progressHref}
      synthetic={query.synthetic === "1"}
      cached={query.cached === "1"}
      live={query.live === "1"}
    />
  );
}
