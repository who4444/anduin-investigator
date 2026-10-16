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

describeDb("pipeline routes", () => {
  let investigationId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const { createInvestigation, insertEvents } = await import("../lib/store");
    const { setLlmClientForTests } = await import("../lib/llm");

    investigationId = await createInvestigation({
      title: `Routes ${randomUUID()}`,
      escalationText: "Totals are wrong since 4.12.",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(investigationId);

    await insertEvents(investigationId, [
      {
        id: "e_routes_00000001",
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change merged for release 4.12.",
      },
    ]);

    setLlmClientForTests({
      chat: async (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("issue analyst")) return { content: "# Plan\n1. Trace 4.12." };
        if (system.includes("skeptic")) {
          return { content: JSON.stringify({ issues: [] }) };
        }
        if (system.includes("one claim against one quote")) {
          return { content: '{"supports":"yes"}' };
        }
        if (messages.some((message) => message.role === "tool")) return { content: '{"claims":[],"notes":[]}' };
        return {
          content: "",
          toolCalls: [
            {
              id: "call_routes_1",
              name: "submit_claim",
              args: {
                type: "root_cause",
                text: "Release 4.12 merged the timezone change.",
                actor: "Lin Chen",
                quote: "Timezone change merged for release 4.12",
                event_id: "e_routes_00000001",
                ts: "2024-09-10T03:00:00.000Z",
                status: "n/a",
                confidence: 0.9,
              },
            },
          ],
        };
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

  it("runs the plan route and marks the stage done", async () => {
    const { POST } = await import("../app/api/investigations/[id]/plan/route");
    const { getStages } = await import("../lib/store");

    const response = await POST(post("http://localhost/plan"), context(investigationId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.plan).toContain("Trace 4.12");
    expect((await getStages(investigationId)).find((stage) => stage.stage === "plan")?.status).toBe("done");
  });

  it("runs an investigator and persists its claims", async () => {
    const { POST } = await import("../app/api/investigations/[id]/investigate/route");
    const { getClaims } = await import("../lib/store");

    const response = await POST(
      post("http://localhost/investigate", { kind: "root_cause", pass: 1 }),
      context(investigationId),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.claimCount).toBeGreaterThanOrEqual(1);
    expect((await getClaims(investigationId)).some((claim) => claim.agent === "root_cause")).toBe(true);
  });

  it("rejects an unknown investigator kind", async () => {
    const { POST } = await import("../app/api/investigations/[id]/investigate/route");

    const response = await POST(
      post("http://localhost/investigate", { kind: "vibes" }),
      context(investigationId),
    );

    expect(response.status).toBe(400);
  });

  it("404s an unknown investigation", async () => {
    const { POST } = await import("../app/api/investigations/[id]/plan/route");

    const response = await POST(
      post("http://localhost/plan"),
      context("8f3c9b2e-0000-4000-8000-000000000000"),
    );

    expect(response.status).toBe(404);
  });

  it("400s a malformed investigation id instead of leaking a database error", async () => {
    const { POST } = await import("../app/api/investigations/[id]/plan/route");
    const { GET: resultRoute } = await import("../app/api/investigations/[id]/result/route");

    const planResponse = await POST(post("http://localhost/plan"), context("not-a-uuid"));
    expect(planResponse.status).toBe(400);

    const resultResponse = await resultRoute(
      new NextRequest("http://localhost/result"),
      context("not-a-uuid"),
    );
    expect(resultResponse.status).toBe(400);
    expect((await resultResponse.json()).error).toMatch(/valid identifier/i);
  });

  it("verifies and assembles, then serves the result without re-logging the assemble stage", async () => {
    const { POST: verify } = await import("../app/api/investigations/[id]/verify/route");
    const { POST: assembleRoute } = await import("../app/api/investigations/[id]/assemble/route");
    const { GET: resultRoute } = await import("../app/api/investigations/[id]/result/route");
    const { getStages } = await import("../lib/store");

    const verifyResponse = await verify(post("http://localhost/verify"), context(investigationId));
    expect(verifyResponse.status).toBe(200);
    const verifyBody = await verifyResponse.json();
    expect(verifyBody.verified).toBe(1);
    expect(verifyBody.supported).toBe(0);

    const assembleResponse = await assembleRoute(
      post("http://localhost/assemble", { pass: 1 }),
      context(investigationId),
    );
    const assembleBody = await assembleResponse.json();
    expect(assembleResponse.status).toBe(200);
    expect(assembleBody.missing).toEqual(["commitments", "ownership"]);

    const assembleLogLength = (await getStages(investigationId)).find(
      (stage) => stage.stage === "assemble",
    )?.log.length;

    const resultResponse = await resultRoute(
      new NextRequest("http://localhost/result"),
      context(investigationId),
    );
    const resultBody = await resultResponse.json();

    expect(resultResponse.status).toBe(200);
    expect(resultBody.ledger).toEqual([]);
    expect(resultBody.stats.verified).toBeGreaterThanOrEqual(1);
    expect(resultBody.investigation.escalationText).toContain("4.12");

    const afterLength = (await getStages(investigationId)).find(
      (stage) => stage.stage === "assemble",
    )?.log.length;
    expect(afterLength).toBe(assembleLogLength);
  });

  it("serves the status route", async () => {
    const { GET } = await import("../app/api/investigations/[id]/status/route");

    const response = await GET(new NextRequest("http://localhost/status"), context(investigationId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.investigation.id).toBe(investigationId);
    expect(Array.isArray(body.stages)).toBe(true);
  });

  it("degrades the skeptic stage gracefully and still returns 200", async () => {
    const { POST } = await import("../app/api/investigations/[id]/skeptic/route");
    const { setLlmClientForTests } = await import("../lib/llm");

    setLlmClientForTests({
      chat: async () => {
        throw new Error("api down");
      },
    });

    const response = await POST(post("http://localhost/skeptic"), context(investigationId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ flagged: 0, issues: 0 });
  });
});
