import type { NextRequest } from "next/server";

import { json, readId, readInvestigationOrDefault, tailLog } from "@/lib/api/pipeline";
import { getStages } from "@/lib/store";

export const maxDuration = 60;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const stages = await getStages(id);

  return json({
    investigation: found.investigation,
    stages: tailLog(found.investigation, stages),
  });
}
