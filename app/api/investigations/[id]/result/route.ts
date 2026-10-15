import type { NextRequest } from "next/server";

import { errorResponse, json, readId, readInvestigationOrDefault } from "@/lib/api/pipeline";
import { buildResult } from "@/lib/pipeline/assemble";

export const maxDuration = 60;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);

  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  try {
    const result = await buildResult(id);
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}
