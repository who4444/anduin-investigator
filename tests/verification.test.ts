import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

type Context = { params: Promise<{ id: string }> };

const context = (id: string): Context => ({ params: Promise.resolve({ id }) });

const post = (url: string, body: unknown = {}): NextRequest =>
  new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

describeDb("three-state verification", () => {
  let investigationId: string;
  let outageId: string;
  const created: string[] = [];
  const llmCalls: string[] = [];

  beforeAll(async () => {
    const { createInvestigation, insertEvents, insertClaims, upsertIdentity } = await import(
      "../lib/store"
    );
    const { setLlmClientForTests } = await import("../lib/llm");

    investigationId = await createInvestigation({
      title: `Verification ${randomUUID()}`,
      escalationText: "Totals are wrong again.",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(investigationId);

    await insertEvents(investigationId, [
      {
        id: "e_verify_slack_1",
        source: "slack",
        ts: "2024-09-20T10:00:00.000Z",
        actor: "Ravi Mehta",
        channel: "seed-eng",
        text: "We will ship the totals fix in the September release.",
      },
      {
        id: "e_verify_jira_1",
        source: "jira",
        ts: "2024-09-21T08:30:00.000Z",
        actor: "Amara Okafor",
        channel: "SEED-101",
        text: "Status moved to In Review after the build passed QA.",
      },
    ]);

    await upsertIdentity(investigationId, {
      alias: "ravi_mehta",
      canonical: "Ravi Mehta",
      method: "email",
      confidence: 1,
      applied: true,
    });

    await insertClaims(investigationId, [
      {
        agent: "commitments",
        type: "commitment",
        text: "Ravi promised the totals fix for the September release.",
        actor: "Ravi Mehta",
        quote: "ship the totals fix in the September release",
        eventId: "e_verify_slack_1",
        ts: "2024-09-20T10:00:00.000Z",
        status: "kept",
        confidence: 0.9,
      },
      {
        agent: "commitments",
        type: "commitment",
        text: "Dana promised the totals fix for the September release.",
        actor: "Dana Lee",
        quote: "ship the totals fix in the September release",
        eventId: "e_verify_slack_1",
        ts: "2024-09-20T10:00:00.000Z",
        status: "kept",
        confidence: 0.6,
      },
      {
        agent: "ownership",
        type: "ownership",
        text: "Amara moved the ticket to review two days late.",
        actor: "Amara Okafor",
        quote: "moved to In Review after the build passed QA",
        eventId: "e_verify_jira_1",
        ts: "2024-09-19T00:00:00.000Z",
        status: "n/a",
        confidence: 0.8,
      },
      {
        agent: "commitments",
        type: "commitment",
        text: "The fix would ship in September.",
        actor: "ravi_mehta",
        quote: "ship the totals fix in the September release",
        eventId: "e_verify_slack_1",
        status: "kept",
        confidence: 0.7,
      },
      {
        agent: "ownership",
        type: "ownership",
        text: "The ticket moved to Done.",
        actor: "Amara Okafor",
        quote: "moved to Done after the build passed",
        eventId: "e_verify_jira_1",
        ts: "2024-09-21T08:30:00.000Z",
        status: "n/a",
        confidence: 0.5,
      },
      {
        agent: "commitments",
        type: "commitment",
        text: "A fixed release shipped on September 24.",
        actor: "Ravi Mehta",
        quote: "shipped on September 24",
        eventId: "e_verify_missing_1",
        ts: "2024-09-24T09:00:00.000Z",
        status: "kept",
        confidence: 0.5,
      },
    ]);

    outageId = await createInvestigation({
      title: `Verification outage ${randomUUID()}`,
      escalationText: "Same issue again.",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(outageId);

    await insertEvents(outageId, [
      {
        id: "e_outage_1",
        source: "jira",
        ts: "2024-09-22T09:00:00.000Z",
        actor: "Amara Okafor",
        channel: "SEED-102",
        text: "Ticket marked Resolved while QA was still failing.",
      },
    ]);
    await insertClaims(outageId, [
      {
        agent: "root_cause",
        type: "process_failure",
        text: "The ticket was marked resolved while QA was still failing.",
        actor: "Amara Okafor",
        quote: "marked Resolved while QA was still failing",
        eventId: "e_outage_1",
        ts: "2024-09-22T09:00:00.000Z",
        status: "n/a",
        confidence: 0.9,
      },
    ]);

    setLlmClientForTests({
      chat: async (messages) => {
        const user = messages[1]?.content ?? "";
        llmCalls.push(user);
        if (user.includes("ship the totals fix in the September release") && user.includes("Ravi promised")) {
          return { content: '{"supports":"yes"}' };
        }
        if (user.includes("The fix would ship in September.")) {
          return { content: '{"supports":"no"}' };
        }
        throw new Error(`unexpected entailment call: ${user.slice(0, 120)}`);
      },
    });
  });

  afterAll(async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    setLlmClientForTests(null);
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) {
      await deleteInvestigation(id);
    }
  });

  it("classifies claims into verified, supported and rejected", async () => {
    llmCalls.length = 0;
    const { POST } = await import("../app/api/investigations/[id]/verify/route");

    const response = await POST(post("http://localhost/verify"), context(investigationId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      total: 6,
      verified: 1,
      supported: 3,
      rejected: 2,
      entailment: { reviewed: 2, unavailable: 0, skipped: 2 },
    });

    expect(llmCalls).toHaveLength(2);
    for (const call of llmCalls) {
      expect(call).toMatch(/^Claim: |\nQuote: /);
      expect(call).not.toMatch(/Dana|Amara|e_verify|moved to In Review/);
    }
  });

  it("stores per-check detail for every claim", async () => {
    const { getClaims } = await import("../lib/store");
    const claims = await getClaims(investigationId);
    const byText = new Map(claims.map((claim) => [claim.text, claim]));

    const verified = byText.get("Ravi promised the totals fix for the September release.");
    expect(verified?.verifyStatus).toBe("verified");
    expect(verified?.checks?.quote?.ok).toBe(true);
    expect(verified?.checks?.attribution?.ok).toBe(true);
    expect(verified?.checks?.entailment?.verdict).toBe("supports");

    const actorMismatch = byText.get("Dana promised the totals fix for the September release.");
    expect(actorMismatch?.verifyStatus).toBe("supported");
    expect(actorMismatch?.verifyError).toBe("actor_mismatch");
    expect(actorMismatch?.checks?.attribution?.reason).toBe("actor_mismatch");
    expect(actorMismatch?.checks?.attribution?.claimActor).toBe("Dana Lee");
    expect(actorMismatch?.checks?.entailment ?? null).toBeNull();

    const tsMismatch = byText.get("Amara moved the ticket to review two days late.");
    expect(tsMismatch?.verifyStatus).toBe("supported");
    expect(tsMismatch?.verifyError).toBe("ts_mismatch");

    const refuted = byText.get("The fix would ship in September.");
    expect(refuted?.verifyStatus).toBe("supported");
    expect(refuted?.verifyError).toBe("entailment_refutes");
    expect(refuted?.checks?.attribution?.ok).toBe(true);
    expect(refuted?.checks?.entailment?.verdict).toBe("refutes");

    const badQuote = byText.get("The ticket moved to Done.");
    expect(badQuote?.verifyStatus).toBe("rejected");
    expect(badQuote?.verifyError).toBe("quote_not_found");

    const missingEvent = byText.get("A fixed release shipped on September 24.");
    expect(missingEvent?.verifyStatus).toBe("rejected");
    expect(missingEvent?.verifyError).toBe("event_not_found");
  });

  it("a model outage downgrades code-passing claims to supported, never rejects", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    setLlmClientForTests({
      chat: async () => {
        throw new Error("api down");
      },
    });

    const { POST } = await import("../app/api/investigations/[id]/verify/route");
    const response = await POST(post("http://localhost/verify"), context(outageId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      total: 1,
      verified: 0,
      supported: 1,
      rejected: 0,
      entailment: { reviewed: 0, unavailable: 1, skipped: 0 },
    });

    const { getClaims } = await import("../lib/store");
    const [claim] = await getClaims(outageId);
    expect(claim.verifyStatus).toBe("supported");
    expect(claim.verifyError).toBe("entailment_unavailable");
    expect(claim.checks?.entailment).toEqual({ verdict: "unavailable", error: "error" });
  });

  it("assembles three-state stats and a trust split that keeps supported claims visible", async () => {
    const { POST: assembleRoute } = await import("../app/api/investigations/[id]/assemble/route");
    const { GET: resultRoute } = await import("../app/api/investigations/[id]/result/route");
    const { GET: reportRoute } = await import("../app/api/investigations/[id]/report/route");

    const assembleResponse = await assembleRoute(
      post("http://localhost/assemble", { pass: 1 }),
      context(investigationId),
    );
    const assembleBody = await assembleResponse.json();
    expect(assembleResponse.status).toBe(200);
    expect(assembleBody.stats).toEqual({ total: 6, verified: 1, supported: 3, rejected: 2, flagged: 0 });
    expect(assembleBody.missing).toEqual(["root_cause"]);

    const resultResponse = await resultRoute(
      new NextRequest("http://localhost/result"),
      context(investigationId),
    );
    const resultBody = await resultResponse.json();
    expect(resultBody.stats.verified).toBe(1);
    expect(
      resultBody.claims.filter((claim: { verifyStatus: string }) => claim.verifyStatus === "supported"),
    ).toHaveLength(3);

    const reportResponse = await reportRoute(
      new NextRequest("http://localhost/report"),
      context(investigationId),
    );
    const reportBody = await reportResponse.json();
    expect(reportResponse.status).toBe(200);
    expect(reportBody.safeToRepeat).toHaveLength(1);
    expect(reportBody.checkWithHuman).toHaveLength(3);
    expect(
      reportBody.checkWithHuman.every(
        (item: { verification: string }) => item.verification === "supported",
      ),
    ).toBe(true);
    expect(reportBody.rejected).toHaveLength(2);
    expect(
      reportBody.rejected.map((item: { reason: string }) => item.reason).sort(),
    ).toEqual(["event_not_found", "quote_not_found"]);
    expect(reportBody.briefing.confidence).toEqual({
      verified: 1,
      supported: 3,
      rejected: 2,
      total: 6,
      flagged: 0,
    });
    expect(reportBody.briefing.events).toHaveLength(4);
    expect(
      reportBody.briefing.events.some(
        (event: { verification: string }) => event.verification === "supported",
      ),
    ).toBe(true);
  });
});
