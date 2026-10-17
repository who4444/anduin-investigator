import type { Investigation, Stage, StageName } from "../types";
import { acquireStageLease, clearStageLease, getInvestigation, upsertStage } from "../store";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

const LOG_TAIL = 20;

export async function readInvestigationOrDefault(
  id: string,
): Promise<{ investigation: Investigation } | { response: Response }> {
  let investigation: Investigation | null = null;
  try {
    investigation = await getInvestigation(id);
  } catch (error) {
    if (!isUuidSyntaxError(error)) throw error;
    return { response: errorResponse("Investigation id is not a valid identifier.", 400) };
  }

  if (!investigation) {
    return { response: errorResponse(`No investigation with id ${id}.`, 404) };
  }
  return { investigation };
}

function isUuidSyntaxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid input syntax for type uuid/i.test(message);
}

export function tailLog(stages: Stage[]): Stage[] {
  return stages.map((stage) => ({ ...stage, log: stage.log.slice(-LOG_TAIL) }));
}

export function readPass(body: unknown, fallback = 1): number {
  if (typeof body !== "object" || body === null) return fallback;
  const raw = (body as Record<string, unknown>).pass;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : fallback;
}

/** The orchestrator sends one worker id per pipeline run so its parallel
    stages share a lease; direct callers get an anonymous one-shot holder. */
export function readWorker(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const raw = (body as Record<string, unknown>).worker;
  return typeof raw === "string" ? raw.slice(0, 64) : "";
}

export async function runStage<T>(
  investigationId: string,
  stage: StageName,
  pass: number,
  work: () => Promise<T>,
  worker = "",
): Promise<Response> {
  // One pipeline RUN at a time per investigation. Stages from the same worker
  // (the parallel investigators of a single run) share the lease; a second
  // tab with its own worker id is refused until the run ends or the lease
  // expires.
  const holder = worker || `direct-${crypto.randomUUID()}`;
  const leased = await acquireStageLease(investigationId, holder);
  if (!leased) {
    return errorResponse(
      "A stage is already running for this investigation. Wait for it to finish, then reload.",
      409,
    );
  }
  try {
    await upsertStage(investigationId, stage, pass, "running");
    const result = await work();
    await upsertStage(investigationId, stage, pass, "done");
    return json(result ?? { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertStage(investigationId, stage, pass, "error", message).catch(() => {
      // Surfacing the original failure matters more than recording it.
    });
    // The run is over: release so the advised reload can retry immediately.
    await clearStageLease(investigationId).catch(() => {});
    return errorResponse(message, 500);
  } finally {
    // Anonymous direct calls are one-shot: release immediately. A worker run
    // (the orchestrator) keeps its lease across stages until assemble ends.
    if (!worker || stage === "assemble") {
      await clearStageLease(investigationId).catch(() => {
        // The lease also expires on its own; never mask the stage's outcome.
      });
    }
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
