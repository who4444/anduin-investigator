import type { Issue, Stage, StageName, StageStatus } from "./types";

export const INVESTIGATOR_KINDS = ["root_cause", "commitments", "ownership"] as const;
export type InvestigatorKindName = (typeof INVESTIGATOR_KINDS)[number];

export interface StageUpdate {
  stage: StageName;
  pass: number;
  status: StageStatus;
  error?: string | null;
}

/** G-13: where a half-finished run resumes. Every stage that is already
    stored as done is never redone; only what is missing (or errored) runs. */
export type ResumePoint = "plan" | "investigate" | "skeptic" | "verify" | "assemble";

export function resumePointFromStages(stages: Stage[]): ResumePoint {
  const done = (stage: string) => stages.some((entry) => entry.stage === stage && entry.status === "done");
  if (!done("plan")) return "plan";
  const investigatorsDone = (INVESTIGATOR_KINDS as readonly string[]).every((kind) => done(kind));
  if (!investigatorsDone) return "investigate";
  if (!done("skeptic")) return "skeptic";
  if (!done("verify")) return "verify";
  return "assemble";
}

export interface RunPipelineOptions {
  onStage?: (update: StageUpdate) => void;
  fetchImpl?: typeof fetch;
  maxRetryPasses?: number;
  onMissingRetry?: (missing: string[], pass: number) => void;
  /** G-23: pause after plan when more than one issue needs a manager review. */
  stopForIssueReview?: boolean;
  /** G-12: pause after plan when the scope is only partially confirmed, so
      the manager sees what will be searched before tokens are spent. */
  stopForScopeReview?: boolean;
  /** Resume a run whose earlier stages are already stored (G-13). */
  startAt?: ResumePoint;
  /** Stable worker id; the issue review pauses and resumes on the same lease. */
  workerId?: string;
}

export type PipelineOutcome =
  | { ok: true; retries: number }
  | { ok: true; paused: true; issues?: Issue[]; scopeReview?: boolean; retries: number }
  | { ok: false; error: string; stage: string; pass: number };

class StageError extends Error {
  constructor(
    readonly stage: string,
    readonly pass: number,
    message: string,
  ) {
    super(message);
    this.name = "StageError";
  }
}

const DEFAULT_MAX_RETRY_PASSES = 1;

export async function runPipeline(
  investigationId: string,
  options: RunPipelineOptions = {},
): Promise<PipelineOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetryPasses = options.maxRetryPasses ?? DEFAULT_MAX_RETRY_PASSES;
  const base = `/api/investigations/${investigationId}`;
  // One lease per pipeline RUN: the server lets concurrent stages through when
  // they come from the same worker, so the parallel investigators keep working
  // while a second tab is still refused. The G-23 issue review pauses the run;
  // the resume must reuse the same worker id or the paused lease refuses it.
  const workerKey = `anduin-worker:${investigationId}`;
  let workerId = options.workerId;
  if (!workerId && typeof window !== "undefined") {
    try {
      workerId = window.sessionStorage.getItem(workerKey) ?? undefined;
    } catch {
      // Storage can be unavailable; fall back to a fresh worker.
    }
  }
  if (!workerId) {
    workerId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `w-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(workerKey, workerId);
      } catch {
        // Ignore storage denial.
      }
    }
  }

  const notify = (stage: StageName, pass: number, status: StageStatus, error?: string | null) => {
    options.onStage?.({ stage, pass, status, error });
  };

  const callStage = async (
    stage: string,
    pass: number,
    body: Record<string, unknown> = {},
    notifyName: string = stage,
  ) => {
    notify(notifyName as StageName, pass, "running");
    let response: Response;
    try {
      response = await fetchImpl(`${base}/${stage}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pass, worker: workerId, ...body }),
      });
    } catch (error) {
      throw new StageError(notifyName, pass, error instanceof Error ? error.message : String(error));
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : `Stage ${stage} failed.`;
      throw new StageError(notifyName, pass, message);
    }
    notify(notifyName as StageName, pass, "done");
    return payload;
  };

  const reportedErrors = new Set<string>();
  const reportError = (error: unknown) => {
    const stageError = error instanceof StageError ? error : undefined;
    const key = `${stageError?.stage ?? "unknown"}:${stageError?.pass ?? 1}`;
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    if (stageError) {
      notify(stageError.stage as StageName, stageError.pass, "error", stageError.message);
    }
  };

  const runInvestigators = async (kinds: readonly InvestigatorKindName[], pass: number) => {
    const results = await Promise.allSettled(
      kinds.map((kind) => callStage("investigate", pass, { kind }, kind)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    for (const failure of failures) reportError(failure.reason);
    if (failures.length > 0) throw failures[0].reason;
  };

  let retries = 0;
  const startAt = options.startAt ?? "plan";

  try {
    if (startAt === "plan") {
      const planPayload = await callStage("plan", 1);
      const issues = Array.isArray(planPayload.issues)
        ? (planPayload.issues as Issue[])
        : [];
      const scope = planPayload.scope as { confidence?: string } | null | undefined;
      // G-12: a partially-confirmed scope is shown for confirmation before
      // any investigator spends tokens on it. Confirming resumes at "plan",
      // whose reuse branch is cheap, so the issue review still runs after.
      if (options.stopForScopeReview && scope && scope.confidence === "partial") {
        return { ok: true, paused: true, scopeReview: true, retries: 0 };
      }
      if (
        options.stopForIssueReview &&
        issues.length > 1 &&
        issues.some((issue) => !issue.confirmed)
      ) {
        return { ok: true, paused: true, issues, retries: 0 };
      }
    }

    for (;;) {
      const pass = 1 + retries;
      const initialPass = retries === 0;
      const skipInvestigators =
        initialPass && startAt !== "plan" && startAt !== "investigate";
      const skipSkeptic =
        initialPass && (startAt === "verify" || startAt === "assemble");
      const skipVerify = initialPass && startAt === "assemble";

      if (initialPass && !skipInvestigators) {
        await runInvestigators(INVESTIGATOR_KINDS, pass);
      }

      if (!skipSkeptic) {
        try {
          await callStage("skeptic", pass);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify("skeptic", pass, "error", message);
        }
      }

      if (!skipVerify) {
        await callStage("verify", pass);
      }

      const assembled = (await callStage("assemble", pass)) as {
        needsRetry?: boolean;
        missing?: string[];
      };
      const missing = Array.isArray(assembled.missing) ? assembled.missing : [];

      if (!assembled.needsRetry || missing.length === 0 || retries >= maxRetryPasses) {
        return { ok: true, retries };
      }

      const retryKinds = missing.filter((kind): kind is InvestigatorKindName =>
        (INVESTIGATOR_KINDS as readonly string[]).includes(kind),
      );
      if (retryKinds.length === 0) {
        return { ok: true, retries };
      }

      retries += 1;
      const retryPass = 1 + retries;
      options.onMissingRetry?.(missing, retryPass);
      await runInvestigators(retryKinds, retryPass);
    }
  } catch (error) {
    reportError(error);
    const stageError = error instanceof StageError ? error : undefined;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stage: stageError?.stage ?? "unknown",
      pass: stageError?.pass ?? 1,
    };
  }
}
