import type { NextRequest } from "next/server";

import {
  readId,
  readInvestigationOrDefault,
  readJsonBody,
  readPass,
  readWorker,
  runStage,
} from "@/lib/api/pipeline";
import { runClaimVerification } from "@/lib/pipeline/verify-claims";

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

  return runStage(id, "verify", pass, async () => runClaimVerification(id, pass), worker);
}
