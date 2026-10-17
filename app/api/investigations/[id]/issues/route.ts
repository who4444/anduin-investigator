import type { NextRequest } from "next/server";

import {
  errorResponse,
  json,
  readId,
  readInvestigationOrDefault,
  readJsonBody,
} from "@/lib/api/pipeline";
import { confirmIssues, getIssues } from "@/lib/store";
import type { IssueInput } from "@/lib/types";

export const maxDuration = 60;
const MAX_ISSUES = 3;

function cleanIssue(value: unknown): IssueInput | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return null;
  const ask = typeof raw.ask === "string" ? raw.ask.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  const summary =
    typeof raw.summary === "string" ? raw.summary.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : 0.5;
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    title: title.slice(0, 120),
    ask,
    summary,
    confidence,
  };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  try {
    const issues = await getIssues(id);
    return json({
      issues,
      confirmed: issues.length > 0 && issues.every((issue) => issue.confirmed),
      overflow: found.investigation.planData?.issueOverflow ?? 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Could not load issues: ${message}`, 500);
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = (await readJsonBody(request)) as { issues?: unknown };
  if (!Array.isArray(body.issues) || body.issues.length < 1) {
    return errorResponse("issues must be an array with at least one issue.", 400);
  }
  if (body.issues.length > MAX_ISSUES) {
    return errorResponse(
      `This escalation has more than ${MAX_ISSUES} issues. Split it into separate escalations before investigating.`,
      400,
    );
  }
  const issues = body.issues.map(cleanIssue);
  if (issues.some((issue) => issue === null)) {
    return errorResponse("Each issue needs a non-empty title.", 400);
  }

  try {
    const saved = await confirmIssues(id, issues as IssueInput[]);
    return json({ issues: saved, confirmed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Could not save issues: ${message}`, 500);
  }
}
