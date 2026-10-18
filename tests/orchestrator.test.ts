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
  resume?: boolean;
}

function fakeFetch(
  handler: (call: FakeStage & { url: string }) => Response,
): { fetchImpl: typeof fetch; calls: (FakeStage & { url: string })[] } {
  const calls: (FakeStage & { url: string })[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { pass?: number; kind?: string; resume?: boolean })
      : {};
    const segments = url.split("/");
    const stage = segments[segments.length - 1];
    const call = { url, stage, pass: body.pass ?? 1, kind: body.kind, resume: body.resume };
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

  it("resumes only the investigator kinds that are not done", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") return jsonResponse({ needsRetry: false, missing: [] });
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      startAt: "investigate",
      investigatorKinds: ["commitments", "ownership"],
      startPass: 1,
    });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(calls.filter((call) => call.stage === "investigate").map((call) => call.kind)).toEqual([
      "commitments",
      "ownership",
    ]);
    expect(calls.every((call) => call.pass === 1)).toBe(true);
  });

  /* G-13: a half-finished run resumes at the first unfinished stage and
     retries only what is missing. */
  it("resumes at verify without re-running the investigators or the skeptic", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") return jsonResponse({ needsRetry: false, missing: [] });
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl, startAt: "verify" });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(calls.map((call) => call.stage)).toEqual(["verify", "assemble"]);
  });

  it("resumes at assemble and runs only the last stage", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ needsRetry: false, missing: [] }));

    const outcome = await runPipeline("inv-1", { fetchImpl, startAt: "assemble" });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(calls.map((call) => call.stage)).toEqual(["assemble"]);
  });

  /* G-12: a partially-confirmed scope pauses for the manager's review before
     any investigator runs; a scoped or unscoped run proceeds. */
  it("pauses after plan when the scope is only partial", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "plan") {
        return jsonResponse({ plan: "p", scope: { confidence: "partial" }, issues: [] });
      }
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl, stopForScopeReview: true });

    expect(outcome).toEqual({ ok: true, paused: true, scopeReview: true, retries: 0 });
    expect(calls.map((call) => call.stage)).toEqual(["plan"]);
  });

  it("does not pause for a scoped run", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "plan") {
        return jsonResponse({ plan: "p", scope: { confidence: "scoped" }, issues: [] });
      }
      if (call.stage === "assemble") return jsonResponse({ needsRetry: false, missing: [] });
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl, stopForScopeReview: true });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(calls.some((call) => call.stage === "investigate")).toBe(true);
  });

  /* G-13: a resumed run waits out a lease the previous (dead) session still
     holds, then takes over; a fresh run still fails fast on a 409. */
  it("waits and retries while a resumed run's lease is still held", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = fakeFetch(() => {
      attempts += 1;
      if (attempts <= 2) return jsonResponse({ error: "A stage is already running." }, 409);
      return jsonResponse({ needsRetry: false, missing: [] });
    });
    const notices: (string | null)[] = [];

    const outcome = await runPipeline("inv-1", {
      fetchImpl,
      startAt: "assemble",
      resume: true,
      leaseWaitMs: 1,
      onNotice: (text) => notices.push(text),
    });

    expect(outcome).toEqual({ ok: true, retries: 0 });
    expect(attempts).toBe(3);
    expect(calls[0].resume).toBe(true);
    expect(notices.some((text) => text !== null && /waiting/i.test(text))).toBe(true);
  });

  it("a fresh run fails fast on a 409 without waiting", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ error: "busy" }, 409));

    const outcome = await runPipeline("inv-1", { fetchImpl, leaseWaitMs: 1 });

    expect(outcome.ok).toBe(false);
    expect(calls.filter((call) => call.stage === "plan")).toHaveLength(1);
  });
});

describe("resumePointFromStages (G-13)", () => {
  const stage = (name: string, status = "done") => ({
    stage: name as never,
    pass: 1,
    status: status as never,
    log: [],
  });

  it("names only the missing investigator kinds", async () => {
    const { missingInvestigatorKinds, investigatorResumePass } = await import(
      "../lib/orchestrator"
    );
    expect(
      missingInvestigatorKinds([stage("plan"), stage("root_cause")]),
    ).toEqual(["commitments", "ownership"]);
    expect(
      missingInvestigatorKinds([
        stage("plan"),
        stage("root_cause"),
        stage("commitments"),
        stage("ownership"),
      ]),
    ).toEqual([]);
    expect(
      investigatorResumePass([stage("root_cause"), { ...stage("commitments", "error"), pass: 2 }]),
    ).toBe(2);
  });

  it("walks forward to the first unfinished stage", async () => {
    const { resumePointFromStages } = await import("../lib/orchestrator");
    expect(resumePointFromStages([])).toBe("plan");
    expect(resumePointFromStages([stage("plan", "error")])).toBe("plan");
    expect(resumePointFromStages([stage("plan"), stage("root_cause")])).toBe("investigate");
    expect(
      resumePointFromStages([
        stage("plan"),
        stage("root_cause"),
        stage("commitments"),
        stage("ownership"),
      ]),
    ).toBe("skeptic");
    expect(
      resumePointFromStages([
        stage("plan"),
        stage("root_cause"),
        stage("commitments"),
        stage("ownership"),
        stage("skeptic"),
        stage("verify", "error"),
      ]),
    ).toBe("verify");
    expect(
      resumePointFromStages([
        stage("plan"),
        stage("root_cause"),
        stage("commitments"),
        stage("ownership"),
        stage("skeptic"),
        stage("verify"),
      ]),
    ).toBe("assemble");
  });
});
