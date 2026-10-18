import type { NextRequest } from "next/server";

import { runInvestigator, type InvestigatorKind } from "@/lib/agents/investigator";
import {
  errorResponse,
  readId,
  readInvestigationOrDefault,
  readJsonBody,
  readPass,
  readResume,
  readWorker,
  runStage,
} from "@/lib/api/pipeline";

export const maxDuration = 60;

const KINDS: InvestigatorKind[] = ["root_cause", "commitments", "ownership"];

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = (await readJsonBody(request)) as Record<string, unknown>;
  const kind = body.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind as InvestigatorKind)) {
    return errorResponse(`kind must be one of ${KINDS.join(", ")}.`, 400);
  }

  const pass = readPass(body);
  const worker = readWorker(body);
  const resume = readResume(body);
  const plan = found.investigation.plan ?? "";

  return runStage(id, kind as InvestigatorKind, pass, async () => {
    const result = await runInvestigator(id, kind as InvestigatorKind, plan, pass);
    return {
      kind,
      pass,
      claimCount: result.claims.length,
      toolCalls: result.log.map((entry) => entry.name),
      title: found.investigation.title,
    };
  }, worker, resume);
}
