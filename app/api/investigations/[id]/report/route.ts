import type { NextRequest } from "next/server";

import { errorResponse, json, readId, readInvestigationOrDefault } from "@/lib/api/pipeline";
import { buildResult } from "@/lib/pipeline/assemble";
import { buildBriefing } from "@/lib/report/briefing";
import { buildReportView } from "@/lib/report/build";
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
    const view = buildReportView({
      events: assembled.timeline,
      claims: assembled.claims,
      notes: assembled.skepticNotes,
    });

    return json({
      investigation: assembled.investigation,
      events: assembled.timeline,
      claims: assembled.claims,
      stats: assembled.stats,
      stages: assembled.stages,
      coverage: assembled.coverage,
      gaps: assembled.gaps,
      skepticNotes: assembled.skepticNotes,
      verdict: extras?.verdict ?? null,
      reply: extras?.reply ?? null,
      ...view,
      briefing: buildBriefing({
        events: assembled.timeline,
        claims: assembled.claims,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}
