import type { NextRequest } from "next/server";

import {
  errorResponse,
  json,
  readInvestigationOrDefault,
  readJsonBody,
} from "@/lib/api/pipeline";
import { clearClaimReview, upsertClaimReview } from "@/lib/store";
import { buildResult, recordReportVersions } from "@/lib/pipeline/assemble";
import type { ClaimReviewVerdict } from "@/lib/types";

export const maxDuration = 60;

const VERDICTS: ClaimReviewVerdict[] = ["wrong", "unsupported", "out_of_scope"];

/* G-14: a correction changes the findings, so freeze a fresh report version
   whose stats record the reviewed count. The previous version stays intact. */
async function freezeAfterReview(investigationId: string): Promise<boolean> {
  try {
    const result = await buildResult(investigationId);
    if (!result.complete) return false;
    await recordReportVersions(result);
    return true;
  } catch {
    // The review is the durable correction; versioning must not lose it.
    return false;
  }
}

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
  // A correction removes evidence from the client pack: the manager must say
  // why, so the audit trail is never a bare verdict.
  if (!reason) {
    return errorResponse("A reason is required when overriding or rejecting a finding.", 400);
  }

  try {
    const review = await upsertClaimReview(id, claimId, verdict as ClaimReviewVerdict, reason || null);
    const versionRecorded = await freezeAfterReview(id);
    return json({ review, versionRecorded });
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
    const versionRecorded = await freezeAfterReview(id);
    return json({ cleared: true, versionRecorded });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Could not clear the review: ${message}`, 500);
  }
}
