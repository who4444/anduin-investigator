import type { StageName, StageStatus } from "./types";

export const INVESTIGATOR_KINDS = ["root_cause", "commitments", "ownership"] as const;
export type InvestigatorKindName = (typeof INVESTIGATOR_KINDS)[number];

export interface StageUpdate {
  stage: StageName;
  pass: number;
  status: StageStatus;
  error?: string | null;
}

export interface RunPipelineOptions {
  onStage?: (update: StageUpdate) => void;
  fetchImpl?: typeof fetch;
  maxRetryPasses?: number;
  onMissingRetry?: (missing: string[], pass: number) => void;
}

export type PipelineOutcome =
  | { ok: true; retries: number }
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

const DEFAULT_MAX_RETRY_PASSES = 2;

export async function runPipeline(
  investigationId: string,
  options: RunPipelineOptions = {},
): Promise<PipelineOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetryPasses = options.maxRetryPasses ?? DEFAULT_MAX_RETRY_PASSES;
  const base = `/api/investigations/${investigationId}`;

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
    const response = await fetchImpl(`${base}/${stage}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pass, ...body }),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : `Stage ${stage} failed.`;
      throw new StageError(notifyName, pass, message);
    }
    notify(notifyName as StageName, pass, "done");
    return payload;
  };

  let retries = 0;

  try {
    await callStage("plan", 1);

    for (;;) {
      const pass = 1 + retries;

      if (retries === 0) {
        await Promise.all(
          INVESTIGATOR_KINDS.map((kind) => callStage("investigate", pass, { kind }, kind)),
        );
      }

      try {
        await callStage("skeptic", pass);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify("skeptic", pass, "error", message);
      }

      await callStage("verify", pass);

      const assembled = (await callStage("assemble", pass)) as {
        needsRetry?: boolean;
        missing?: string[];
      };
      const missing = Array.isArray(assembled.missing) ? assembled.missing : [];

      if (!assembled.needsRetry || missing.length === 0 || retries >= maxRetryPasses) {
        return { ok: true, retries };
      }

      retries += 1;
      const retryPass = 1 + retries;
      options.onMissingRetry?.(missing, retryPass);
      await Promise.all(
        missing
          .filter((kind): kind is InvestigatorKindName =>
            (INVESTIGATOR_KINDS as readonly string[]).includes(kind),
          )
          .map((kind) => callStage("investigate", retryPass, { kind }, kind)),
      );
    }
  } catch (error) {
    const stageError = error instanceof StageError ? error : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (stageError) {
      notify(stageError.stage as StageName, stageError.pass, "error", message);
    }
    return {
      ok: false,
      error: message,
      stage: stageError?.stage ?? "unknown",
      pass: stageError?.pass ?? 1,
    };
  }
}
