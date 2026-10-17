import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

/* G-03 end to end at the store level: a "no reply" finding while a source was
   never searched may not be verified, may not enter safe-to-repeat, and is
   marked with the missing coverage; with a complete search it may be
   supported but never verified. */

const NEGATIVE_QUOTE = "No reply has been sent to the customer yet.";
const NEGATIVE_TEXT = "The client received no reply.";

describeDb("negative claims (G-03)", () => {
  let incompleteId: string;
  let completeId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const { createInvestigation, insertClaims, insertEvents, appendStageLog } = await import(
      "../lib/store"
    );
    const { setLlmClientForTests } = await import("../lib/llm");
    setLlmClientForTests({ chat: async () => ({ content: '{"supports":"yes"}' }) });

    async function seed(title: string): Promise<string> {
      const id = await createInvestigation({
        title: `${title} ${randomUUID()}`,
        escalationText: "The client says nobody answered them.",
        contentHash: `hash-${randomUUID()}`,
      });
      created.push(id);
      await insertEvents(id, [
        {
          id: "e_neg_slack",
          source: "slack",
          ts: "2024-09-29T08:00:00.000Z",
          actor: "Marcus Webb",
          channel: "meridian-billing",
          text: NEGATIVE_QUOTE,
        },
        {
          id: "e_neg_email",
          source: "email",
          ts: "2024-09-27T03:05:00.000Z",
          actor: "Priya Nair <priya.nair@northwind.example>",
          channel: "email",
          text: "Still waiting for any answer at all.",
        },
      ]);
      await insertClaims(id, [
        {
          agent: "ownership",
          type: "process_failure",
          text: NEGATIVE_TEXT,
          actor: "Marcus Webb",
          quote: NEGATIVE_QUOTE,
          eventId: "e_neg_slack",
          ts: "2024-09-29T08:00:00.000Z",
          status: "n/a",
          confidence: 0.9,
        },
      ]);
      return id;
    }

    incompleteId = await seed("Negative incomplete");
    // The email source exists but nothing ever searched it: the negative's
    // search is incomplete.

    completeId = await seed("Negative complete");
    await appendStageLog(completeId, "root_cause", 1, {
      toolCalls: [
        { name: "search_slack", args: {}, resultCount: 1 },
        { name: "search_email", args: {}, resultCount: 1 },
      ],
    });
  });

  afterAll(async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    setLlmClientForTests(null);
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) await deleteInvestigation(id);
  });

  it("caps an incompletely-searched negative at supported with the proof attached", async () => {
    const { runClaimVerification } = await import("../lib/pipeline/verify-claims");
    const { getClaims } = await import("../lib/store");

    const summary = await runClaimVerification(incompleteId);
    expect(summary.verified).toBe(0);

    const [claim] = await getClaims(incompleteId);
    expect(claim.verifyStatus).toBe("supported");
    expect(claim.verifyError).toBe("evidence_incomplete");
    expect(claim.checks?.negative?.complete).toBe(false);
    expect(claim.checks?.negative?.notSearched).toContain("email");
    expect(claim.checks?.negative?.basis).toContain("never searched");
  });

  it("keeps the incomplete negative out of safe-to-repeat and causes", async () => {
    const { getClaims, getEvents } = await import("../lib/store");
    const { buildReportView } = await import("../lib/report/build");

    const view = buildReportView({
      events: await getEvents(incompleteId),
      claims: await getClaims(incompleteId),
      notes: [],
    });

    expect(view.safeToRepeat).toHaveLength(0);
    expect(view.checkWithHuman).toHaveLength(1);
    expect(view.checkWithHuman[0].verifyError).toBe("evidence_incomplete");
    expect(view.causes.map((cause) => cause.text)).not.toContain(NEGATIVE_TEXT);
  });

  it("supports a completely-searched negative but never verifies it", async () => {
    const { runClaimVerification } = await import("../lib/pipeline/verify-claims");
    const { getClaims } = await import("../lib/store");

    const summary = await runClaimVerification(completeId);
    expect(summary.verified).toBe(0);
    expect(summary.supported).toBe(1);

    const [claim] = await getClaims(completeId);
    expect(claim.verifyStatus).toBe("supported");
    expect(claim.verifyError).toBe("negative_inference");
    expect(claim.checks?.negative?.complete).toBe(true);
  });
});
