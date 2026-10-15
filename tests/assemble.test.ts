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

    // root_cause: one claim that verifies, one whose quote is wrong (excluded).
    // commitments: one verifying commitment.
    // ownership: none — so it is "missing" and can trigger a retry.
    await insertClaims(investigationId, [
      {
        agent: "root_cause",
        type: "root_cause",
        text: "The 4.12 timezone change introduced the defect.",
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
        quote: "Fix is promised for the Sep 24 release.",
        eventId: slackId,
        ts: "2024-09-20T09:00:00.000Z",
        status: "broken",
        confidence: 0.8,
      },
    ]);
  });

  afterAll(async () => {
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) {
      await deleteInvestigation(id);
    }
  });

  it("verifies claims by quote, excludes failures, and reports stats", async () => {
    const { runClaimVerification } = await import("../lib/pipeline/verify-claims");
    const { getClaims } = await import("../lib/store");

    const summary = await runClaimVerification(investigationId);

    expect(summary).toMatchObject({ total: 3, kept: 2, excluded: 1 });

    const claims = await getClaims(investigationId);
    const excluded = claims.find((claim) => claim.verifyStatus === "excluded");
    expect(excluded?.verifyError).toBe("quote_not_found");
  });

  it("assembles timeline, ledger, gaps and stats, and flags the missing investigator", async () => {
    const { assemble } = await import("../lib/pipeline/assemble");
    const { upsertStage } = await import("../lib/store");
    await upsertStage(investigationId, "root_cause", 1, "done");

    const result = await assemble(investigationId);

    expect(result.timeline.map((event) => event.id)).toEqual([jiraId, slackId]);
    expect(result.ledger.map((claim) => claim.type)).toEqual(["commitment"]);
    expect(result.stats).toEqual({ total: 3, kept: 2, excluded: 1, flagged: 0 });
    expect(result.missing).toEqual(["ownership"]);
    expect(result.pass).toBe(1);
    expect(result.needsRetry).toBe(true);
    expect(result.investigation.id).toBe(investigationId);
    expect(result.stages.some((stage) => stage.stage === "root_cause")).toBe(true);
    expect(result.coverage.sources).toHaveLength(3);
    expect(result.coverage.neverSearched).toEqual(["jira", "slack"]);
  });

  it("stops retrying at pass 3", async () => {
    const { assemble } = await import("../lib/pipeline/assemble");
    const { upsertStage } = await import("../lib/store");

    await upsertStage(investigationId, "ownership", 3, "done");
    await upsertStage(investigationId, "root_cause", 3, "done");

    const result = await assemble(investigationId);

    expect(result.pass).toBe(3);
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

    expect(result.stats).toMatchObject({ total: 2, kept: 1, excluded: 1 });
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0].quote).toBe("promised the fix for the Sep 24 release");
  });
});
