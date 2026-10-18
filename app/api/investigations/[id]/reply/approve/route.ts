import type { NextRequest } from "next/server";

import {
  errorResponse,
  json,
  readId,
  readInvestigationOrDefault,
  readJsonBody,
} from "@/lib/api/pipeline";
import { getIssueReportExtras, getIssues, getReportExtras, setReplyApproved } from "@/lib/store";

export const maxDuration = 60;

/* G-07: approval is a state on the stored draft, not a UI-only checkbox.
   Copying a client reply is only enabled after this succeeds. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = (await readJsonBody(request)) as { issueId?: unknown; approved?: unknown };
  const issueId = typeof body.issueId === "string" && body.issueId.trim() ? body.issueId.trim() : null;
  if (typeof body.approved !== "boolean") {
    return errorResponse("approved must be true or false.", 400);
  }
  if (issueId) {
    const issue = (await getIssues(id)).find((candidate) => candidate.id === issueId);
    if (!issue) return errorResponse("No issue with that id belongs to this investigation.", 404);
  }

  const extras = issueId ? await getIssueReportExtras(id, issueId) : await getReportExtras(id);
  if (!extras?.reply) {
    return errorResponse("Draft the client reply before approving it.", 409);
  }

  const updated = await setReplyApproved(id, issueId, body.approved);
  if (!updated) return errorResponse("No stored draft to approve.", 404);
  return json({ approved: body.approved });
}
