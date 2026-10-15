import type { NextRequest } from "next/server";

import { runAnalyst } from "@/lib/agents/analyst";
import {
  readId,
  readInvestigationOrDefault,
  readJsonBody,
  readPass,
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

  const pass = readPass(await readJsonBody(request));

  return runStage(id, "plan", pass, async () => {
    const plan = await runAnalyst(id, found.investigation.escalationText, pass);
    return { plan };
  });
}
