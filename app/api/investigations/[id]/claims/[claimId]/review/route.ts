import type { NextRequest } from "next/server";

import {
  errorResponse,
  json,
  readInvestigationOrDefault,
  readJsonBody,
} from "@/lib/api/pipeline";
import { clearClaimReview, upsertClaimReview } from "@/lib/store";
import type { ClaimReviewVerdict } from "@/lib/types";

export const maxDuration = 60;

const VERDICTS: ClaimReviewVerdict[] = ["wrong", "unsupported", "out_of_scope"];

/* G-14: the manager's correction. A reviewed claim leaves the findings, the
   client pack and the draft; the review is the audit trail. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; claimId: string }> },
): Promise<Response> {
  const { id, claimId } = await context.params;
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = (await readJsonBody(request)) as { verdict?: unknown; reason?: unknown };
  const verdict = typeof body.verdict === "string" ? body.verdict : "";
  if (!VERDICTS.includes(verdict as ClaimReviewVerdict)) {
    return errorResponse(`verdict must be one of ${VERDICTS.join(", ")}.`, 400);
  }
  const reason =
    typeof body.reason === "string" ? body.reason.replace(/\s+/g, " ").trim().slice(0, 500) : "";

  try {
    const review = await upsertClaimReview(id, claimId, verdict as ClaimReviewVerdict, reason || null);
    return json({ review });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No claim with that id/.test(message) || /invalid input syntax for type uuid/i.test(message)) {
      return errorResponse("No claim with that id belongs to this investigation.", 404);
    }
    return errorResponse(`Could not save the review: ${message}`, 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string; claimId: string }> },
): Promise<Response> {
  const { id, claimId } = await context.params;
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  try {
    await clearClaimReview(id, claimId);
    return json({ cleared: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Could not clear the review: ${message}`, 500);
  }
}
