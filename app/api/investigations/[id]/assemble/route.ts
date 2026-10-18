import type { NextRequest } from "next/server";

import {
  readId,
  readInvestigationOrDefault,
  readJsonBody,
  readPass,
  readResume,
  readWorker,
  runStage,
} from "@/lib/api/pipeline";
import { assemble } from "@/lib/pipeline/assemble";

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = await readJsonBody(request);
  const pass = readPass(body);
  const worker = readWorker(body);
  const resume = readResume(body);

  return runStage(id, "assemble", pass, async () => {
    const result = await assemble(id);
    return {
      needsRetry: result.needsRetry,
      missing: result.missing,
      retryKinds: result.retryKinds,
      retryReasons: result.retryReasons,
      stats: result.stats,
    };
  }, worker, resume);
}
