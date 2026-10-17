import type { NextRequest } from "next/server";

import { errorResponse, json, readId, readInvestigationOrDefault } from "@/lib/api/pipeline";
import { buildResult } from "@/lib/pipeline/assemble";
import { clientDomainsFor } from "@/lib/pipeline/scope";
import { buildBriefing } from "@/lib/report/briefing";
import { buildBottomLine } from "@/lib/report/bottomline";
import { buildReportView } from "@/lib/report/build";
import { pruneStaleReply } from "@/lib/agents/reply";
import { getReportExtras } from "@/lib/store";

export const maxDuration = 60;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  try {
    const assembled = await buildResult(id);
    const extras = await getReportExtras(id);
    const prunedReply = pruneStaleReply(extras?.reply ?? null, assembled.claims);
    const view = buildReportView({
      events: assembled.timeline,
      claims: assembled.claims,
      notes: assembled.skepticNotes,
      commitments: assembled.commitments,
      clientDomains: clientDomainsFor(assembled.timeline, assembled.scope),
    });

    return json({
      investigation: assembled.investigation,
      events: assembled.timeline,
      excludedEvents: assembled.excludedEvents,
      claims: assembled.claims,
      stats: assembled.stats,
      stages: assembled.stages,
      coverage: assembled.coverage,
      gaps: assembled.gaps,
      skepticNotes: assembled.skepticNotes,
      verdict: extras ? (prunedReply ? extras.verdict : null) : null,
      reply: prunedReply,
      ...view,
      briefing: buildBriefing({
        events: assembled.timeline,
        claims: assembled.claims,
        commitments: assembled.commitments,
      }),
      bottomLine: buildBottomLine({
        events: assembled.timeline,
        claims: assembled.claims,
        notes: assembled.skepticNotes,
        gaps: assembled.gaps,
        commitments: assembled.commitments,
      }),
      scope: assembled.scope,
      complete: assembled.complete,
      missing: assembled.missing,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}
