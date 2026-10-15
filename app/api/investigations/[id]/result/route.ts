import type { NextRequest } from "next/server";

import { errorResponse, json, readId } from "@/lib/api/pipeline";
import { buildResult } from "@/lib/pipeline/assemble";

export const maxDuration = 60;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);

  try {
    const result = await buildResult(id);
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, message.includes("No investigation") ? 404 : 500);
  }
}
