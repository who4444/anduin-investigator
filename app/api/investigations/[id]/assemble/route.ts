import type { NextRequest } from "next/server";

import {
  readId,
  readInvestigationOrDefault,
  readJsonBody,
  readPass,
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

  const pass = readPass(await readJsonBody(request));

  return runStage(id, "assemble", pass, async () => {
    const result = await assemble(id);
    return { needsRetry: result.needsRetry, missing: result.missing, stats: result.stats };
  });
}
