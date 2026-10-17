import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";
import {
  applyStatusRules,
  commitmentDedupeKey,
  mergeStatuses,
  normalizeObject,
} from "../lib/pipeline/commitments";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describe("commitment rules (G-05)", () => {
  it("normalizes the object so dates and filler stop splitting one promise", () => {
    expect(normalizeObject("invoice totals corrected by September 24")).toBe(
      normalizeObject("invoice totals corrected in the Sep 24 release"),
    );
    expect(normalizeObject("Invoice totals corrected by 24 Sep")).toBe(
      normalizeObject("the invoice totals corrected"),
    );
  });

  it("keys the same promise identically across wordings and deadline forms", () => {
    const key = (object: string, deadlineIso: string | null) =>
      commitmentDedupeKey({ promisor: "Marcus Webb", promisee: "Northwind", object, deadlineIso });

    expect(key("invoice totals corrected in Sep 24", "2024-09-24T00:00:00.000Z")).toBe(
      key("invoice totals corrected by September 24", "2024-09-24T00:00:00.000Z"),
    );
    // A different deadline is a different promise; no deadline is its own key.
    expect(key("invoice totals corrected", "2024-09-24T00:00:00.000Z")).not.toBe(
      key("invoice totals corrected", "2024-10-01T00:00:00.000Z"),
    );
    expect(key("invoice totals corrected", null)).toContain("no-deadline");
  });

  it("a failing outcome outweighs a kept reading, and disagreement is contested", () => {
    expect(mergeStatuses(["kept", "broken"], null)).toMatchObject({
      status: "broken",
      contested: true,
    });
    expect(mergeStatuses(["kept", "kept"], "release cut")).toMatchObject({
      status: "kept",
      contested: false,
      rationale: "release cut",
    });
  });

  it("kept requires evidence of delivery", () => {
    expect(applyStatusRules({ status: "kept", fulfilmentEventIds: [], rationale: null })).toMatchObject({
      status: "unclear",
    });
    expect(
      applyStatusRules({ status: "kept", fulfilmentEventIds: ["e1"], rationale: "released" }),
    ).toMatchObject({ status: "kept" });
  });
});

describeDb("commitments end to end (G-05)", () => {
  let investigationId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const { createInvestigation, insertEvents } = await import("../lib/store");
    investigationId = await createInvestigation({
      title: `Commitments ${randomUUID()}`,
      escalationText: "When will the invoice totals be fixed?",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(investigationId);

    await insertEvents(investigationId, [
      {
        id: "e_cm_jira",
        source: "jira",
        ts: "2024-09-20T10:00:00.000Z",
        actor: "Marcus Webb",
        channel: "MER-101",
        text: "The fix will ship in the Sep 24 release.",
      },
      {
        id: "e_cm_slack",
        source: "slack",
        ts: "2024-09-21T11:00:00.000Z",
        actor: "Marcus Webb",
        channel: "meridian-billing",
        text: "Invoice totals will be corrected by September 24.",
      },
      {
        id: "e_cm_email",
        source: "email",
        ts: "2024-09-22T12:00:00.000Z",
        actor: "Marcus Webb <marcus.webb@meridian.example>",
        channel: "email",
        text: "We promise the invoice totals by 24 Sep.",
      },
    ]);
  });

  afterAll(async () => {
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) await deleteInvestigation(id);
  });

  it("merges the same promise from three tools into one contested row", async () => {
    const { buildAgentTools } = await import("../lib/agents/tools");
    const { getClaims, getCommitments, setClaimVerification } = await import("../lib/store");

    const tools = buildAgentTools(investigationId, "commitments");
    const submissions = [
      {
        text: "The fix will ship in the Sep 24 release.",
        object: "invoice totals corrected",
        deadline: "Sep 24",
        quote: "The fix will ship in the Sep 24 release.",
        item_id: "e_cm_jira",
        status: "broken",
        rationale: "the Sep 24 build failed QA",
      },
      {
        text: "Invoice totals will be corrected by September 24.",
        object: "invoice totals corrected",
        deadline: "September 24",
        quote: "Invoice totals will be corrected by September 24.",
        item_id: "e_cm_slack",
        status: "kept",
        rationale: "release announced as cut",
      },
      {
        text: "We promise the invoice totals by 24 Sep.",
        object: "invoice totals corrected",
        deadline: "24 Sep",
        quote: "We promise the invoice totals by 24 Sep.",
        item_id: "e_cm_email",
        status: "unclear",
        rationale: null,
      },
    ];

    for (const submission of submissions) {
      const result = JSON.parse(
        await tools.exec("submit_commitment", {
          ...submission,
          actor: "Marcus Webb",
          to: "Northwind",
          confidence: 0.8,
        }),
      ) as { commitmentId?: string; claimId?: string; error?: string };
      expect(result.error, JSON.stringify(result)).toBeUndefined();
      if (result.claimId) {
        await setClaimVerification(result.claimId, "verified", null, {
          quote: { ok: true },
          attribution: null,
          entailment: null,
        });
      }
    }

    const commitments = await getCommitments(investigationId);
    expect(commitments).toHaveLength(1);
    const [commitment] = commitments;
    // kept-without-delivery was downgraded to unclear, then broken beats the
    // rest — one row, contested, with all three source records.
    expect(commitment.status).toBe("broken");
    expect(commitment.contested).toBe(true);
    expect(commitment.sourceEventIds).toHaveLength(3);
    expect(commitment.deadlineIso?.slice(0, 10)).toBe("2024-09-24");

    // The ledger renders exactly that row, and the top line agrees with it.
    const { buildLedger } = await import("../lib/report/build");
    const { buildBottomLine } = await import("../lib/report/bottomline");
    const events = await import("../lib/store").then((store) => store.getEvents(investigationId));
    const claims = await getClaims(investigationId);

    const rows = buildLedger({ events, claims, notes: [], commitments });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "broken", contested: true, mergedClaims: 3 });

    const bottom = buildBottomLine({ events, claims, notes: [], gaps: [], commitments });
    const promises = bottom.cells.find((cell) => cell.id === "promises");
    expect(promises).toMatchObject({ value: "1 of 1 broken", tone: "bad" });
  });
});
