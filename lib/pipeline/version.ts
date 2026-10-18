/* G-08: cache identity must include the run's model and prompt/pipeline
   version. A cached answer from a different model must never be served as if
   this run produced it. Bump PIPELINE_VERSION whenever prompt semantics or
   report rules change in a way that should invalidate caches. */
export const PIPELINE_VERSION = "2026-10-18-p0.2";

export function modelVersion(): string {
  return process.env.DEEPSEEK_MODEL?.trim() || "unknown-model";
}

export function runVersionKey(): string {
  return `${PIPELINE_VERSION}:${modelVersion()}`;
}
