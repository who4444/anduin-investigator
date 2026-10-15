import type { Investigation, StageName } from "../types";
import { getInvestigation, upsertStage } from "../store";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

export async function readInvestigationOrDefault(
  id: string,
): Promise<{ investigation: Investigation } | { response: Response }> {
  let investigation: Investigation | null = null;
  try {
    investigation = await getInvestigation(id);
  } catch {
    return { response: errorResponse("Investigation id is not a valid identifier.", 400) };
  }

  if (!investigation) {
    return { response: errorResponse(`No investigation with id ${id}.`, 404) };
  }
  return { investigation };
}

export function readPass(body: unknown, fallback = 1): number {
  if (typeof body !== "object" || body === null) return fallback;
  const raw = (body as Record<string, unknown>).pass;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : fallback;
}

export async function runStage<T>(
  investigationId: string,
  stage: StageName,
  pass: number,
  work: () => Promise<T>,
): Promise<Response> {
  await upsertStage(investigationId, stage, pass, "running");
  try {
    const result = await work();
    await upsertStage(investigationId, stage, pass, "done");
    return json(result ?? { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertStage(investigationId, stage, pass, "error", message).catch(() => {
      // Surfacing the original failure matters more than recording it.
    });
    return errorResponse(message, 500);
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function readId(params: Promise<{ id: string }>): Promise<string> {
  const resolved = await params;
  return resolved.id;
}
