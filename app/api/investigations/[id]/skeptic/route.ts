import type { NextRequest } from "next/server";

import { runSkeptic } from "@/lib/agents/skeptic";
import {
  readId,
  readInvestigationOrDefault,
  readJsonBody,
  readPass,
  readResume,
  readWorker,
  runStage,
} from "@/lib/api/pipeline";

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

  return runStage(id, "skeptic", pass, async () => runSkeptic(id, pass), worker, resume);
}
