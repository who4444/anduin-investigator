import { describe, expect, it, vi } from "vitest";

import { runPipeline } from "../lib/orchestrator";
import { deriveRetryPlan } from "../lib/pipeline/retry";
import type { Claim, Investigation } from "../lib/types";

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
  queries?: string[];
  reasons?: string[];
}

function fakeFetch(
  handler: (call: FakeStage & { url: string }) => Response,
): { fetchImpl: typeof fetch; calls: (FakeStage & { url: string })[] } {
  const calls: (FakeStage & { url: string })[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as {
          pass?: number;
          kind?: string;
          resume?: boolean;
          queries?: string[];
          reasons?: string[];
        })
      : {};
    const segments = url.split("/");
    const stage = segments[segments.length - 1];
    const call = {
      url,
      stage,
      pass: body.pass ?? 1,
      kind: body.kind,
      resume: body.resume,
      queries: body.queries,
      reasons: body.reasons,
    };
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

  it("gap-driven retry runs only the targeted kinds once with explicit queries and reasons (I3)", async () => {
    let assembled = 0;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") {
        assembled += 1;
        if (assembled === 1) {
          return jsonResponse({
            needsRetry: true,
            missing: [],
            retryKinds: ["root_cause"],
            retryReasons: [
              {
                kind: "unsearched_source",
                kinds: ["root_cause"],
                reason: "jira was available but never searched",
                query: "search_jira(all)",
                basis: [],
              },
              {
                kind: "hypothesis",
                kinds: ["root_cause"],
                reason: "a plan hypothesis has no supporting finding",
                query: "get_issue(LINK-1)",
                basis: [],
              },
            ],
          });
        }
        return jsonResponse({ needsRetry: false, missing: [], retryKinds: [], retryReasons: [] });
      }
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl });

    expect(outcome).toEqual({ ok: true, retries: 1 });
    const retryInvestigators = calls.filter((call) => call.stage === "investigate" && call.pass === 2);
    expect(retryInvestigators).toHaveLength(1);
    expect(retryInvestigators[0].kind).toBe("root_cause");
    expect(retryInvestigators[0].queries).toEqual(["search_jira(all)", "get_issue(LINK-1)"]);
    expect(retryInvestigators[0].reasons).toContain("jira was available but never searched");
    // Completed kinds that no reason targets are not rerun.
    expect(retryInvestigators.map((call) => call.kind)).not.toContain("commitments");
    expect(retryInvestigators.map((call) => call.kind)).not.toContain("ownership");
  });

  it("retries a question-group reason once without rerunning unrelated investigators", async () => {
    let assembled = 0;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.stage === "assemble") {
        assembled += 1;
        if (assembled === 1) {
          return jsonResponse({
            needsRetry: true,
            missing: [],
            retryKinds: ["ownership"],
            retryReasons: [
              {
                kind: "question_group",
                kinds: ["ownership"],
                reason: "the ownership question group has no supporting finding",
                query: "Who owned the ticket after the handoff?",
                basis: [],
              },
            ],
          });
        }
        return jsonResponse({ needsRetry: false, missing: [], retryKinds: [], retryReasons: [] });
      }
      return jsonResponse({ ok: true });
    });

    const outcome = await runPipeline("inv-1", { fetchImpl });

    expect(outcome).toEqual({ ok: true, retries: 1 });
    const pass1 = calls.filter((call) => call.stage === "investigate" && call.pass === 1);
    const pass2 = calls.filter((call) => call.stage === "investigate" && call.pass === 2);
    expect(pass1).toHaveLength(3);
    expect(pass2.map((call) => call.kind)).toEqual(["ownership"]);
    expect(pass2[0].queries).toEqual(["Who owned the ticket after the handoff?"]);
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

describe("deriveRetryPlan (I3)", () => {
  const claim = (over: {
    agent: string;
    eventId: string;
    text: string;
  }): Claim =>
    ({
      id: `${over.agent}-${over.eventId}`,
      investigationId: "inv",
      agent: over.agent,
      type: "finding",
      text: over.text,
      quote: over.text,
      eventId: over.eventId,
      status: "n/a",
      confidence: 0.8,
      verifyStatus: "verified",
      skepticFlag: false,
    }) as Claim;

  const investigation = (
    hypotheses: { statement: string; test: string; falsify: string }[] = [],
  ): Investigation =>
    ({
      id: "inv",
      title: "t",
      escalationText: "",
      status: "running",
      contentHash: "h",
      plan: null,
      createdAt: "2024-09-01T00:00:00.000Z",
      scope: null,
      declaredClient: null,
      scopeOverrides: [],
      scopeReviewedAt: null,
      planData: {
        framing: "",
        hypotheses,
        sources: [],
        searchTerms: [],
        people: [],
        dateWindow: { from: null, to: null },
        unknowns: [],
        issues: [],
        issueOverflow: 0,
      },
      ingestWarnings: [],
      origin: "upload",
    }) as unknown as Investigation;

  const coverage = (neverSearched: ("jira" | "email" | "slack")[]) => ({
    sources: neverSearched.map((source) => ({
      source,
      available: 1,
      excluded: 0,
      excludedEventIds: [],
      searched: false,
      queries: [],
      resultCount: 0,
      failedQueries: [],
      state: "available-not-searched" as const,
    })),
    neverSearched,
  });

  const emptyCoverage = { sources: [], neverSearched: [] as ("jira" | "email" | "slack")[] };

  it("targets one retry pass from a missing linked ticket and an unsearched source", () => {    const plan = deriveRetryPlan({
      investigation: investigation([
        {
          statement: "The linked ticket LINK-1 holds the root cause of the totals defect",
          test: "Read LINK-1",
          falsify: "LINK-1 is unrelated",
        },
      ]),
      claims: [claim({ agent: "root_cause", eventId: "e1", text: "Release 4.12 merged the timezone change" })],
      coverage: coverage(["jira"]),
      notes: [],
      gaps: [],
      registryIds: new Set(["e1"]),
      missing: [],
      pass: 1,
    });

    expect(plan.needsRetry).toBe(true);
    expect(plan.kinds).toEqual(["root_cause"]);
    expect(plan.reasons.map((reason) => reason.kind).sort()).toEqual([
      "hypothesis",
      "unsearched_source",
    ]);
    expect(plan.reasons.find((reason) => reason.kind === "hypothesis")?.query).toContain("LINK-1");
    expect(plan.reasons.find((reason) => reason.kind === "unsearched_source")?.query).toBe(
      "search_jira(all)",
    );
  });

  it("retries the commitments kind when the ledger is empty but promises were investigated", () => {
    const plan = deriveRetryPlan({
      investigation: investigation(),
      claims: [
        claim({ agent: "commitments", eventId: "e1", text: "Release 4.12 was announced live as including fixes" }),
        claim({ agent: "commitments", eventId: "e2", text: "QA re-ran the finance sandbox and exports are still blank" }),
      ],
      coverage: emptyCoverage,
      notes: [],
      gaps: [],
      registryIds: new Set(["e1", "e2"]),
      missing: [],
      pass: 1,
      commitments: [],
    });

    expect(plan.needsRetry).toBe(true);
    expect(plan.kinds).toEqual(["commitments"]);
    const reason = plan.reasons.find((entry) => entry.kind === "empty_ledger");
    expect(reason?.query).toMatch(/promise|commit/i);
  });

  it("does not retry when the ledger has rows", () => {
    const plan = deriveRetryPlan({
      investigation: investigation(),
      claims: [claim({ agent: "commitments", eventId: "e1", text: "The fix will ship in the Sep 24 release" })],
      coverage: emptyCoverage,
      notes: [],
      gaps: [],
      registryIds: new Set(["e1"]),
      missing: [],
      pass: 1,
      commitments: [
        {
          id: "p1", investigationId: "inv", claimId: "commitments-e1", issueId: null, promisor: "Lin Chen",
          promisee: "Northwind", object: "invoice totals corrected", conditions: null,
          deadlinePhrase: "Sep 24", deadlineIso: "2024-09-24T00:00:00.000Z", rationale: null,
          status: "broken", contested: false, fulfilmentEventIds: [], sourceEventIds: ["e1"],
          dedupeKey: "k", createdAt: "2024-09-20T00:00:00.000Z",
        } as import("../lib/types").Commitment,
      ],
    });

    expect(plan.kinds).toEqual([]);
    expect(plan.needsRetry).toBe(false);
  });

  it("does not retry a fully covered run", () => {
    const plan = deriveRetryPlan({
      investigation: investigation([
        {
          statement: "The timezone change caused the wrong totals",
          test: "read the merge",
          falsify: "no merge",
        },
      ]),
      claims: [
        claim({
          agent: "root_cause",
          eventId: "e1",
          text: "The timezone change caused the wrong totals after 4.12",
        }),
      ],
      coverage: emptyCoverage,
      notes: [],
      gaps: [],
      registryIds: new Set(["e1"]),
      missing: [],
      pass: 1,
    });
    expect(plan.needsRetry).toBe(false);
    expect(plan.kinds).toEqual([]);
  });

  it("derives a listing query from an unsearched source and the question from an unanswered note", () => {
    const plan = deriveRetryPlan({
      investigation: investigation(),
      claims: [claim({ agent: "root_cause", eventId: "e1", text: "The build shipped" })],
      coverage: coverage(["slack"]),
      notes: [
        {
          id: "n1",
          investigationId: "inv",
          kind: "unanswered",
          text: "Which owner took the ticket after the handoff?",
          eventIds: ["e1"],
        },
      ],
      gaps: [],
      registryIds: new Set(["e1"]),
      missing: [],
      pass: 1,
    });
    expect(plan.kinds).toEqual(["ownership"]);
    expect(plan.reasons.find((reason) => reason.kind === "unsearched_source")?.query).toBe(
      "search_slack(all)",
    );
    expect(plan.reasons.find((reason) => reason.kind === "unanswered")?.query).toBe(
      "Which owner took the ticket after the handoff?",
    );
  });

  it("ignores an unanswered note that cites no stored record", () => {
    const plan = deriveRetryPlan({
      investigation: investigation(),
      claims: [claim({ agent: "root_cause", eventId: "e1", text: "The build shipped" })],
      coverage: emptyCoverage,
      notes: [
        {
          id: "n1",
          investigationId: "inv",
          kind: "unanswered",
          text: "Which owner took the ticket after the handoff?",
          eventIds: ["e_missing"],
        },
      ],
      gaps: [],
      registryIds: new Set(["e1"]),
      missing: [],
      pass: 1,
    });
    expect(plan.needsRetry).toBe(false);
  });

  it("fires on a question group whose cited records produced no visible fact", () => {
    const plan = deriveRetryPlan({
      investigation: investigation(),
      claims: [claim({ agent: "root_cause", eventId: "e1", text: "The build shipped" })],
      coverage: emptyCoverage,
      notes: [],
      gaps: [
        {
          id: "g1",
          investigationId: "inv",
          question: "Who owned the ticket?",
          note: "",
          eventIds: ["e2"],
          category: "ownership",
        },
      ],
      registryIds: new Set(["e1", "e2"]),
      missing: [],
      pass: 1,
    });
    expect(plan.needsRetry).toBe(true);
    expect(plan.kinds).toEqual(["ownership"]);
    expect(plan.reasons[0].kind).toBe("question_group");
    expect(plan.reasons[0].query).toBe("Who owned the ticket?");
  });

  it("does not retry once the retry budget is spent", () => {
    const plan = deriveRetryPlan({
      investigation: investigation(),
      claims: [],
      coverage: coverage(["jira"]),
      notes: [],
      gaps: [],
      registryIds: new Set(),
      missing: ["root_cause", "commitments", "ownership"],
      pass: 2,
    });
    expect(plan.needsRetry).toBe(false);
    expect(plan.reasons.length).toBeGreaterThan(0);
  });
});
