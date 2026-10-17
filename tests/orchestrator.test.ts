import { describe, expect, it, vi } from "vitest";

import { runPipeline } from "../lib/orchestrator";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

interface FakeStage {
  stage: string;
  pass: number;
  kind?: string;
}

function fakeFetch(
  handler: (call: FakeStage & { url: string }) => Response,
): { fetchImpl: typeof fetch; calls: (FakeStage & { url: string })[] } {
  const calls: (FakeStage & { url: string })[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { pass?: number; kind?: string }) : {};
    const segments = url.split("/");
    const stage = segments[segments.length - 1];
    const call = { url, stage, pass: body.pass ?? 1, kind: body.kind };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("runPipeline", () => {
  it("runs plan, the three investigators in parallel, skeptic, verify and assemble once", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") return jsonResponse({ needsRetry: false, missing: [] });
      return jsonResponse({ ok: true });
    });

    const updates: string[] = [];
    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      onStage: (update) => updates.push(`${update.stage}:${update.pass}:${update.status}`),
    });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(calls.map((call) => call.stage)).toEqual([
      "plan",
      "investigate",
      "investigate",
      "investigate",
      "skeptic",
      "verify",
      "assemble",
    ]);
    expect(new Set(calls.filter((call) => call.stage === "investigate").map((call) => call.kind))).toEqual(
      new Set(["root_cause", "commitments", "ownership"]),
    );
    expect(updates).toContain("plan:1:running");
    expect(updates).toContain("plan:1:done");
    expect(updates).toContain("assemble:1:done");
  });

  it("re-runs only the missing investigators on a retry pass", async () => {
    let assemblePass1Seen = false;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") {
        if (!assemblePass1Seen) {
          assemblePass1Seen = true;
          return jsonResponse({ needsRetry: true, missing: ["ownership"] });
        }
        return jsonResponse({ needsRetry: false, missing: [] });
      }
      return jsonResponse({ ok: true });
    });

    const retries: { missing: string[]; pass: number }[] = [];
    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      onMissingRetry: (missing, pass) => retries.push({ missing, pass }),
    });

    expect(outcome).toEqual({ ok: true, retries: 1 });
    expect(retries).toEqual([{ missing: ["ownership"], pass: 2 }]);

    const retryInvestigators = calls.filter((call) => call.stage === "investigate" && call.pass === 2);
    expect(retryInvestigators).toHaveLength(1);
    expect(retryInvestigators[0].kind).toBe("ownership");
    expect(calls.find((call) => call.stage === "verify" && call.pass === 2)).toBeDefined();
  });

  it("stops retrying after the retry budget is spent", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") return jsonResponse({ needsRetry: true, missing: ["ownership"] });
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl, maxRetryPasses: 2 });

    expect(outcome).toEqual({ ok: true, retries: 2 });
    const assembleCalls = calls.filter((call) => call.stage === "assemble");
    expect(assembleCalls.map((call) => call.pass)).toEqual([1, 2, 3]);
  });

  it("aborts and reports the failing stage before assemble runs", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "investigate" && call.kind === "root_cause") {
        return jsonResponse({ error: "model unavailable" }, 500);
      }
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl });

    expect(outcome).toEqual({ ok: false, error: "model unavailable", stage: "root_cause", pass: 1 });
    expect(calls.some((call) => call.stage === "assemble")).toBe(false);
  });

  it("treats a failing skeptic as non-fatal and continues", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "skeptic") return jsonResponse({ error: "api down" }, 500);
      if (call.stage === "assemble") return jsonResponse({ needsRetry: false, missing: [] });
      return jsonResponse({ ok: true });
    });

    const updates: string[] = [];
    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      onStage: (update) => updates.push(`${update.stage}:${update.status}`),
    });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(updates).toContain("skeptic:error");
    expect(calls.some((call) => call.stage === "verify")).toBe(true);
    expect(calls.some((call) => call.stage === "assemble")).toBe(true);
  });

  it("keeps running the remaining stages when one investigator fails alongside siblings", async () => {
    const { fetchImpl } = fakeFetch((call) => {
      if (call.stage === "assemble") return jsonResponse({ needsRetry: false, missing: [] });
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl });
    expect(outcome.ok).toBe(true);
  });
});

describe("runPipeline notifications", () => {
  it("reports stage errors through onStage", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/plan")) {
        return jsonResponse({ error: "no events" }, 500);
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      onStage: (update) => seen.push(`${update.stage}:${update.status}:${update.error ?? ""}`),
    });

    expect(outcome.ok).toBe(false);
    expect(seen).toEqual(["plan:running:", "plan:error:no events"]);
  });

  it("reports a rejected fetch as a stage error instead of an unknown stage", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      onStage: (update) => seen.push(`${update.stage}:${update.status}:${update.error ?? ""}`),
    });

    expect(outcome).toEqual({ ok: false, error: "network down", stage: "plan", pass: 1 });
    expect(seen).toEqual(["plan:running:", "plan:error:network down"]);
  });

  it("reports every failed investigator when several fail in parallel", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as { kind?: string }) : {};
      if (url.endsWith("/investigate")) {
        return jsonResponse({ error: `cannot run ${body.kind}` }, 500);
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      onStage: (update) =>
        update.status === "error" ? seen.push(`${update.stage}:${update.error ?? ""}`) : undefined,
    });

    expect(outcome.ok).toBe(false);
    expect(seen.sort()).toEqual([
      "commitments:cannot run commitments",
      "ownership:cannot run ownership",
      "root_cause:cannot run root_cause",
    ]);
  });

  it("skips a retry pass when the missing list names no known investigator", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") {
        return jsonResponse({ needsRetry: true, missing: ["something_else"] });
      }
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(calls.filter((call) => call.stage === "assemble")).toHaveLength(1);
  });

  it("pauses after plan when multiple issues need a manager review", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "plan") {
        return jsonResponse({
          ok: true,
          issues: [
            { id: "i1", title: "Invoice totals", confirmed: false },
            { id: "i2", title: "SSO login", confirmed: false },
          ],
        });
      }
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      stopForIssueReview: true,
    });

    expect(outcome).toMatchObject({ ok: true, paused: true });
    if (outcome.ok && "paused" in outcome) {
      expect(outcome.issues).toHaveLength(2);
    }
    expect(calls.map((call) => call.stage)).toEqual(["plan"]);
  });

  it("continues after plan when the issues are already confirmed", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "plan") {
        return jsonResponse({
          ok: true,
          issues: [
            { id: "i1", title: "Invoice totals", confirmed: true },
            { id: "i2", title: "SSO login", confirmed: true },
          ],
        });
      }
      if (call.stage === "assemble") return jsonResponse({ needsRetry: false, missing: [] });
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      stopForIssueReview: true,
    });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(calls.some((call) => call.stage === "investigate")).toBe(true);
  });

  it("resumes at investigate without re-running the plan", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") return jsonResponse({ needsRetry: false, missing: [] });
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      startAt: "investigate",
    });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(calls.some((call) => call.stage === "plan")).toBe(false);
    expect(calls.filter((call) => call.stage === "investigate")).toHaveLength(3);
  });
});
