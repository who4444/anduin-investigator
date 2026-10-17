import type { NextRequest } from "next/server";

import { generateReply } from "@/lib/agents/reply";
import {
  errorResponse,
  json,
  readId,
  readInvestigationOrDefault,
  readJsonBody,
} from "@/lib/api/pipeline";
import { buildResult } from "@/lib/pipeline/assemble";

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = (await readJsonBody(request)) as { issueId?: unknown };
  const issueId = typeof body.issueId === "string" && body.issueId.trim() ? body.issueId.trim() : null;

  try {
    // G-01 invariant: a reply must never be drafted while the client's own
    // evidence sits outside the investigation. Today the recall guard keeps
    // client evidence in by construction, so this tripwire fires when a
    // future filter (overrides, windows) reintroduces the exclusion — the
    // draft path must not silently outrun the searched records.
    const assembled = await buildResult(id);
    const excluded = assembled.scope?.excludedClientRecords ?? 0;
    if (excluded > 0) {
      return errorResponse(
        `Client evidence is excluded from this investigation (${excluded} record${excluded === 1 ? "" : "s"}). A reply could contradict records that were never searched, so drafting is blocked until the scope is resolved.`,
        409,
      );
    }

    const draft = await generateReply(id, issueId);
    return json(draft);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 502);
  }
}
