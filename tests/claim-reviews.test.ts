import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

type Context = { params: Promise<{ id: string; claimId: string }> };

const context = (id: string, claimId: string): Context => ({
  params: Promise.resolve({ id, claimId }),
});

const post = (body: unknown): NextRequest =>
  new NextRequest("http://localhost/review", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/* G-14 acceptance: a corrected claim disappears from the findings and the
   client pack, the review is the audit trail, and the frozen version's stats
   record that a correction happened. */
describeDb("claim reviews (G-14)", () => {
  let investigationId = "";
  let claimA = "";
  let claimB = "";

  beforeAll(async () => {
    const {
      createInvestigation,
      insertClaims,
      insertEvents,
      mergeCommitment,
      setClaimVerification,
      upsertStage,
    } = await import("../lib/store");
    investigationId = await createInvestigation({
      title: `Reviews ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    await insertEvents(investigationId, [
      {
        id: "e_rv_1",
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change merged for release 4.12.",
      },
      {
        id: "e_rv_2",
        source: "slack",
        ts: "2024-09-24T16:00:00.000Z",
        actor: "Marcus Webb",
        channel: "meridian-billing",
        text: "Sep 24 release is cut; the invoice fix is included.",
      },
    ]);
    const inserted = await insertClaims(investigationId, [
      {
        agent: "root_cause",
        type: "root_cause",
        text: "The 4.12 timezone change introduced the defect.",
        quote: "Timezone change merged for release 4.12",
        eventId: "e_rv_1",
        ts: "2024-09-10T03:00:00.000Z",
        status: "n/a",
        confidence: 0.9,
      },
      {
        agent: "commitments",
        type: "commitment",
        text: "The fix shipped in the Sep 24 release.",
        quote: "the invoice fix is included",
        eventId: "e_rv_2",
        ts: "2024-09-24T16:00:00.000Z",
        status: "kept",
        confidence: 0.8,
      },
    ]);
    claimA = inserted[0].id;
    claimB = inserted[1].id;
    await setClaimVerification(claimA, "verified", null, { quote: { ok: true } });
    await setClaimVerification(claimB, "verified", null, { quote: { ok: true } });
    await mergeCommitment(investigationId, {
      claimId: claimB,
      issueId: null,
      promisor: "Marcus Webb",
      promisee: "Northwind",
      object: "invoice totals fixed in the Sep 24 release",
      conditions: null,
      deadlinePhrase: "Sep 24",
      deadlineIso: "2024-09-24T00:00:00.000Z",
      rationale: null,
      fulfilmentEventIds: [],
      status: "broken",
      sourceEventId: "e_rv_2",
      dedupeKey: "rv|invoice totals|2024-09-24",
    });
    // Make the investigation look assembled so the review route freezes a new
    // report version and stats.reviewed can be asserted.
    await upsertStage(investigationId, "assemble", 1, "done");
    const { assemble } = await import("../lib/pipeline/assemble");
    await assemble(investigationId);
  });

  afterAll(async () => {
    const { deleteInvestigation } = await import("../lib/store");
    await deleteInvestigation(investigationId);
  });

  it("records a review, removes the finding, and keeps the audit trail", async () => {
    const { POST } = await import("../app/api/investigations/[id]/claims/[claimId]/review/route");
    const response = await POST(
      post({ verdict: "wrong", reason: "the merge predates the incident" }),
      context(investigationId, claimA),
    );
    const body = (await response.json()) as { review?: { verdict: string; reason: string } };

    expect(response.status).toBe(200);
    expect(body.review).toMatchObject({ verdict: "wrong", reason: "the merge predates the incident" });

    const { buildResult } = await import("../lib/pipeline/assemble");
    const result = await buildResult(investigationId);
    expect(result.claims.find((claim) => claim.id === claimA)?.review?.verdict).toBe("wrong");
    expect(result.stats.reviewed).toBe(1);

    const { buildReportView } = await import("../lib/report/build");
    const view = buildReportView({ events: result.timeline, claims: result.claims, notes: [] });

    expect(view.safeToRepeat.map((item) => item.claimId)).not.toContain(claimA);
    expect(view.checkWithHuman.map((item) => item.claimId)).not.toContain(claimA);
    expect(view.causes.map((cause) => cause.claimId)).not.toContain(claimA);
    expect(
      view.rejected.some(
        (item) => item.claimId === claimA && item.reason.includes("reviewed: wrong"),
      ),
    ).toBe(true);
    // The untouched verified claim is still safe to repeat.
    expect(view.safeToRepeat.map((item) => item.claimId)).toContain(claimB);

    // G-14/G-08: the correction froze a new report version whose stats carry it.
    const { getLatestReportVersion } = await import("../lib/store");
    const version = await getLatestReportVersion(investigationId, null);
    expect((version?.stats as { reviewed?: number } | undefined)?.reviewed).toBe(1);
  });

  it("removes a reviewed promise from the ledger, the bottom line and the metric", async () => {
    const { POST, DELETE } = await import(
      "../app/api/investigations/[id]/claims/[claimId]/review/route"
    );
    const response = await POST(
      post({ verdict: "unsupported", reason: "the release note was about a different fix" }),
      context(investigationId, claimB),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { versionRecorded?: boolean }).versionRecorded).toBe(true);

    const { buildResult } = await import("../lib/pipeline/assemble");
    const { buildBottomLine } = await import("../lib/report/bottomline");
    const { buildReportView } = await import("../lib/report/build");
    const result = await buildResult(investigationId);
    expect(result.stats.reviewed).toBe(2);

    const view = buildReportView({
      events: result.timeline,
      claims: result.claims,
      notes: [],
      commitments: result.commitments,
    });
    expect(view.ledger.some((row) => row.claimId === claimB)).toBe(false);

    const bottom = buildBottomLine({
      events: result.timeline,
      claims: result.claims,
      notes: [],
      gaps: [],
      commitments: result.commitments,
    });
    const promises = bottom.cells.find((cell) => cell.id === "promises");
    expect(promises?.claimIds).not.toContain(claimB);
    expect(view.metrics.find((metric) => metric.id === "commitments")?.claimIds).not.toContain(claimB);

    const { getLatestReportVersion } = await import("../lib/store");
    const version = await getLatestReportVersion(investigationId, null);
    expect((version?.stats as { reviewed?: number } | undefined)?.reviewed).toBe(2);

    // Leave the fixture clean for the DELETE test below.
    await DELETE(
      new NextRequest("http://localhost/review", { method: "DELETE" }),
      context(investigationId, claimB),
    );
  });

  it("rejects an unknown verdict and an unknown claim, and clears on DELETE", async () => {
    const { POST, DELETE } = await import(
      "../app/api/investigations/[id]/claims/[claimId]/review/route"
    );

    expect((await POST(post({ verdict: "meh" }), context(investigationId, claimA))).status).toBe(400);
    expect(
      (await POST(post({ verdict: "wrong" }), context(investigationId, claimA))).status,
    ).toBe(400);
    expect(
      (await POST(post({ verdict: "wrong", reason: "quote misreads the record" }), context(investigationId, randomUUID()))).status,
    ).toBe(404);

    const cleared = await DELETE(
      new NextRequest("http://localhost/review", { method: "DELETE" }),
      context(investigationId, claimA),
    );
    expect(cleared.status).toBe(200);

    const { getClaimReviews } = await import("../lib/store");
    expect(await getClaimReviews(investigationId)).toHaveLength(0);
  });
});
