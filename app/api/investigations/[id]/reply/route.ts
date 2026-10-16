import type { NextRequest } from "next/server";

import { generateReply } from "@/lib/agents/reply";
import { errorResponse, json, readId, readInvestigationOrDefault } from "@/lib/api/pipeline";

export const maxDuration = 60;

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  try {
    const draft = await generateReply(id);
    return json(draft);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 502);
  }
}
