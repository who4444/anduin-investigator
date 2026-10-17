import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const jiraId = "e_assemble_0000001";
const slackId = "e_assemble_0000002";

describeDb("verify + assemble", () => {
  let investigationId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const { createInvestigation, insertEvents, insertClaims } = await import("../lib/store");
    const { setLlmClientForTests } = await import("../lib/llm");
    setLlmClientForTests({ chat: async () => ({ content: '{"supports":"yes"}' }) });
    investigationId = await createInvestigation({
      title: `Assemble ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(investigationId);

    await insertEvents(investigationId, [
      {
        id: slackId,
        source: "slack",
        ts: "2024-09-20T09:00:00.000Z",
        actor: "Marcus",
        channel: "meridian-billing",
        text: "Fix is promised for the Sep 24 release.",
      },
      {
        id: jiraId,
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change merged for release 4.12.",
      },
    ]);

    // root_cause: one claim that verifies, one whose quote is wrong (rejected).
    // commitments: one verifying commitment.
    // ownership: none — so it is "missing" and can trigger a retry.
    await insertClaims(investigationId, [
      {
        agent: "root_cause",
        type: "root_cause",
        text: "The 4.12 timezone change introduced the defect.",
        actor: "Lin Chen",
        quote: "Timezone change merged for release 4.12",
        eventId: jiraId,
        ts: "2024-09-10T03:00:00.000Z",
        status: "n/a",
        confidence: 0.9,
      },
      {
        agent: "root_cause",
        type: "root_cause",
        text: "A claim with a quote that does not exist in the event.",
        quote: "this sentence is not in the event",
        eventId: jiraId,
        status: "n/a",
        confidence: 0.5,
      },
      {
        agent: "commitments",
        type: "commitment",
        text: "A fix was promised for the Sep 24 release.",
        actor: "Marcus",
        quote: "Fix is promised for the Sep 24 release.",
        eventId: slackId,
        ts: "2024-09-20T09:00:00.000Z",
        status: "broken",
        confidence: 0.8,
      },
    ]);
  });

  afterAll(async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    setLlmClientForTests(null);
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) {
      await deleteInvestigation(id);
    }
  });

  it("verifies claims by quote, keeps the actor/time match, and reports three states", async () => {
    const { runClaimVerification } = await import("../lib/pipeline/verify-claims");
    const { getClaims } = await import("../lib/store");

    const summary = await runClaimVerification(investigationId);

    expect(summary).toMatchObject({ total: 3, verified: 2, supported: 0, rejected: 1 });

    const claims = await getClaims(investigationId);
    const rejected = claims.find((claim) => claim.verifyStatus === "rejected");
    expect(rejected?.verifyError).toBe("quote_not_found");
    const verified = claims.filter((claim) => claim.verifyStatus === "verified");
    expect(verified.every((claim) => claim.checks?.entailment?.verdict === "supports")).toBe(true);
  });

  it("assembles timeline, ledger, gaps and stats, and flags the missing investigator", async () => {
    const { assemble } = await import("../lib/pipeline/assemble");
    const { upsertStage } = await import("../lib/store");
    await upsertStage(investigationId, "root_cause", 1, "done");

    const result = await assemble(investigationId);

    expect(result.timeline.map((event) => event.id)).toEqual([jiraId, slackId]);
    expect(result.ledger.map((claim) => claim.type)).toEqual(["commitment"]);
    expect(result.stats).toEqual({ total: 3, verified: 2, supported: 0, rejected: 1, flagged: 0 });
    expect(result.missing).toEqual(["ownership"]);
    expect(result.pass).toBe(1);
    expect(result.needsRetry).toBe(true);
    expect(result.investigation.id).toBe(investigationId);
    expect(result.stages.some((stage) => stage.stage === "root_cause")).toBe(true);
    expect(result.coverage.sources).toHaveLength(3);
    expect(result.coverage.neverSearched).toEqual(["jira", "slack"]);
  });

  it("stops retrying after one retry pass (max 2 iterations)", async () => {
    const { assemble } = await import("../lib/pipeline/assemble");
    const { upsertStage } = await import("../lib/store");

    await upsertStage(investigationId, "ownership", 2, "done");
    await upsertStage(investigationId, "root_cause", 2, "done");

    const result = await assemble(investigationId);

    expect(result.pass).toBe(2);
    expect(result.missing).toEqual(["ownership"]);
    expect(result.needsRetry).toBe(false);
  });

  it("keeps failed-verification commitments out of the ledger", async () => {
    const { createInvestigation, insertEvents, insertClaims } = await import("../lib/store");
    const { runClaimVerification } = await import("../lib/pipeline/verify-claims");
    const { assemble } = await import("../lib/pipeline/assemble");

    const id = await createInvestigation({
      title: `Ledger ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(id);

    await insertEvents(id, [
      {
        id: "e_ledger_0000001",
        source: "email",
        ts: "2024-09-20T09:00:00.000Z",
        actor: "Priya Nair",
        channel: "email",
        text: "You promised the fix for the Sep 24 release.",
      },
    ]);
    await insertClaims(id, [
      {
        agent: "commitments",
        type: "commitment",
        text: "A fix was promised for the Sep 24 release.",
        quote: "promised the fix for the Sep 24 release",
        eventId: "e_ledger_0000001",
        status: "broken",
        confidence: 0.9,
      },
      {
        agent: "commitments",
        type: "commitment",
        text: "A promise worded so its quote cannot be found.",
        quote: "a sentence that never appears anywhere",
        eventId: "e_ledger_0000001",
        status: "broken",
        confidence: 0.9,
      },
    ]);

    await runClaimVerification(id);
    const result = await assemble(id);

    expect(result.stats).toMatchObject({ total: 2, verified: 0, supported: 1, rejected: 1 });
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0].quote).toBe("promised the fix for the Sep 24 release");
  });

  it("excludes out-of-scope records from the report timeline and reports the exclusion", async () => {
    const { createInvestigation, insertEvents, insertClaims, setScope, deleteInvestigation } =
      await import("../lib/store");
    const { buildResult } = await import("../lib/pipeline/assemble");
    const id = await createInvestigation({
      title: `Scoped ${randomUUID()}`,
      escalationText: "Northwind escalation about Meridian Billing.",
      contentHash: `hash-${randomUUID()}`,
    });
    try {
      await insertEvents(id, [
        {
          id: "e_scope_in_1",
          source: "jira",
          ts: "2024-09-10T03:00:00.000Z",
          actor: "Lin Chen",
          channel: "MER-201",
          text: "Timezone change merged for release 4.12.",
        },
        {
          id: "e_scope_out_1",
          source: "jira",
          ts: "2024-09-11T03:00:00.000Z",
          actor: "Ravi Patel",
          channel: "KST-301",
          text: "Acme rate limits were raised.",
        },
        {
          id: "e_scope_out_2",
          source: "slack",
          ts: "2024-09-12T03:00:00.000Z",
          actor: "Ravi Patel",
          channel: "kestrel-eng",
          text: "Acme's Kestrel change is live.",
        },
      ]);
      await insertClaims(id, [
        {
          agent: "root_cause",
          type: "root_cause",
          text: "The 4.12 timezone change introduced the defect.",
          actor: "Lin Chen",
          quote: "Timezone change merged for release 4.12.",
          eventId: "e_scope_in_1",
          status: "n/a",
          confidence: 0.9,
        },
        {
          agent: "ownership",
          type: "process_failure",
          text: "Acme's rate-limit change shipped in the same window.",
          actor: "Ravi Patel",
          quote: "Acme's Kestrel change is live.",
          eventId: "e_scope_out_2",
          status: "n/a",
          confidence: 0.6,
        },
      ]);
      await setScope(id, {
        client: "Northwind Logistics",
        project: "Meridian Billing",
        ticketPrefixes: ["MER"],
        channels: ["meridian-billing"],
        senderDomains: ["northwind.example"],
        confidence: "scoped",
        anchors: [],
      });

      const result = await buildResult(id);

      expect(result.timeline.map((event) => event.id)).toEqual(["e_scope_in_1"]);
      // Claims citing out-of-scope records are excluded from the report set
      // and disclosed — never shown with a fabricated source.
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0].eventId).toBe("e_scope_in_1");
      expect(result.stats).toMatchObject({ total: 1 });
      expect(result.scope).toEqual({
        client: "Northwind Logistics",
        project: "Meridian Billing",
        ticketPrefixes: ["MER"],
        channels: ["meridian-billing"],
        senderDomains: ["northwind.example"],
        confidence: "scoped",
        anchors: [],
        excludedRecords: 2,
        excludedClaims: 1,
      });
    } finally {
      await deleteInvestigation(id);
    }
  });
});
