import type { EntailmentVerdict } from "../types";
import type { LlmClient } from "../llm";

export type EntailmentError = "timeout" | "unparsable" | "error" | "budget_exhausted";

export interface EntailmentResult {
  verdict: EntailmentVerdict;
  error?: EntailmentError;
}

export interface EntailmentItem {
  claimId: string;
  text: string;
  quote: string;
}

export interface EntailmentLayerOptions {
  client: LlmClient;
  concurrency?: number;
  perCallTimeoutMs?: number;
  totalBudgetMs?: number;
}

export interface EntailmentLayerOutcome {
  results: Map<string, EntailmentResult>;
  reviewed: number;
  unavailable: number;
}

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_PER_CALL_TIMEOUT_MS = 10_000;
export const DEFAULT_TOTAL_BUDGET_MS = 40_000;

const SYSTEM_PROMPT = [
  "You check one claim against one quote from a source record.",
  'Decide only whether the quote supports the claim. Answer with JSON only: {"supports":"yes"|"partial"|"no"}.',
  'Use "yes" only when the quote directly states or clearly evidences the claim.',
  'Use "partial" when the quote supports only part of the claim.',
  'Use "no" when the quote does not support the claim.',
].join(" ");

export function parseEntailment(content: string): "supports" | "partial" | "refutes" | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const raw = (parsed as { supports?: unknown }).supports;
  if (typeof raw === "boolean") return raw ? "supports" : "refutes";
  if (typeof raw !== "string") return null;

  const value = raw.trim().toLowerCase();
  if (value === "yes" || value === "supports") return "supports";
  if (value === "partial") return "partial";
  if (value === "no" || value === "refutes") return "refutes";
  return null;
}

export async function judgeEntailment(
  client: LlmClient,
  input: { text: string; quote: string },
  opts: { timeoutMs?: number } = {},
): Promise<EntailmentResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const response = await Promise.race([
      client.chat(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Claim: ${input.text}\nQuote: ${input.quote}` },
        ],
        { forceJson: true, temperature: 0 },
      ),
      timeout,
    ]);

    if (response === "timeout") return { verdict: "unavailable", error: "timeout" };
    const verdict = parseEntailment(response.content);
    return verdict ? { verdict } : { verdict: "unavailable", error: "unparsable" };
  } catch {
    return { verdict: "unavailable", error: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runEntailmentLayer(
  items: EntailmentItem[],
  options: EntailmentLayerOptions,
): Promise<EntailmentLayerOutcome> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const budget = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const deadline = Date.now() + budget;
  const results = new Map<string, EntailmentResult>();
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];

      if (Date.now() > deadline) {
        results.set(item.claimId, { verdict: "unavailable", error: "budget_exhausted" });
        continue;
      }

      const result = await judgeEntailment(
        options.client,
        { text: item.text, quote: item.quote },
        { timeoutMs: options.perCallTimeoutMs },
      );
      results.set(item.claimId, result);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  let reviewed = 0;
  let unavailable = 0;
  for (const result of results.values()) {
    if (result.verdict === "unavailable") unavailable += 1;
    else reviewed += 1;
  }

  return { results, reviewed, unavailable };
}
