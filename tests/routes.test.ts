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
  // A run-unique client name: learned scopes are global state (by design),
  // and this suite must not couple to whatever other suites have learned.
  const routesClient = `Routes Client ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const { createInvestigation, insertEvents } = await import("../lib/store");
    const { setLlmClientForTests } = await import("../lib/llm");

    investigationId = await createInvestigation({
      title: `Routes ${randomUUID()}`,
      escalationText: "Totals are wrong since 4.12.",
      contentHash: `hash-${randomUUID()}`,
      declaredClient: routesClient,
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
        if (system.includes("issue analyst")) {
          return {
            content: JSON.stringify({
              framing: "Trace 4.12 across the sources.",
              hypotheses: [
                {
                  statement: "The 4.12 merge introduced the drift.",
                  test: "Compare totals before and after Sep 10.",
                  falsify: "Totals unchanged across the deploy.",
                },
              ],
            }),
          };
        }
        if (system.includes("identify which client and project")) {
          return {
            content: JSON.stringify({
              client: "Northwind Logistics",
              project: "Meridian Billing",
              ticketPrefixes: ["MER"],
              channels: [],
              senderDomains: [],
            }),
          };
        }
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
    const { getInvestigation, getStages } = await import("../lib/store");

    const response = await POST(post("http://localhost/plan"), context(investigationId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.plan).toContain("Trace 4.12");
    expect((await getStages(investigationId)).find((stage) => stage.stage === "plan")?.status).toBe("done");

    // The structured plan is persisted alongside the rendered text, and the
    // identified scope is verified against the registry and persisted.
    // Declared client + one verified identifier is 2 anchors: partial.
    const investigation = await getInvestigation(investigationId);
    expect(investigation?.planData?.framing).toContain("Trace 4.12");
    expect(investigation?.planData?.hypotheses[0].statement).toContain("4.12 merge");
    expect(investigation?.scope).toEqual({
      client: routesClient,
      project: "Meridian Billing",
      ticketPrefixes: ["MER"],
      channels: [],
      senderDomains: [],
      confidence: "partial",
      anchors: [
        { kind: "declared-client", value: routesClient, source: "declared" },
        { kind: "ticket-prefix", value: "MER", source: "linked" },
      ],
    });
  });

  it("stores manager-reviewed records, drops unknown ids, and includes them in the report", async () => {
    const { PUT } = await import("../app/api/investigations/[id]/scope/route");
    const {
      createInvestigation,
      deleteInvestigation,
      getInvestigation,
      insertEvents,
      setScope,
    } = await import("../lib/store");
    const { buildResult } = await import("../lib/pipeline/assemble");

    const id = await createInvestigation({
      title: `Scope review ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });

    try {
      await insertEvents(id, [
        {
          id: "e_scope_review_in",
          source: "jira",
          ts: "2024-09-10T03:00:00.000Z",
          actor: "Lin Chen",
          channel: "MER-101",
          text: "Timezone change merged for release 4.12.",
        },
        {
          id: "e_scope_review_out",
          source: "slack",
          ts: "2024-09-28T09:00:00.000Z",
          actor: "Ravi Patel",
          channel: "kestrel-eng",
          text: "Acme noise, out of scope.",
        },
      ]);
      await setScope(id, {
        client: routesClient,
        project: null,
        ticketPrefixes: ["MER"],
        channels: [],
        senderDomains: [],
        confidence: "partial",
        anchors: [],
      });

      const response = await PUT(
        new NextRequest("http://localhost/scope", {
          method: "PUT",
          body: JSON.stringify({ includeEventIds: ["e_scope_review_out", "e_scope_review_ghost"] }),
          headers: { "content-type": "application/json" },
        }),
        context(id),
      );
      const body = (await response.json()) as { includeEventIds: string[] };

      expect(response.status).toBe(200);
      // The unknown id is dropped; the known one is kept and stored.
      expect(body.includeEventIds).toEqual(["e_scope_review_out"]);
      expect((await getInvestigation(id))?.scopeOverrides).toEqual(["e_scope_review_out"]);

      // The reviewed record now reaches the report and is disclosed as such.
      const result = await buildResult(id);
      expect(result.timeline.map((event) => event.id)).toContain("e_scope_review_out");
      expect(result.scope?.includedByReview).toBe(1);
      expect(result.scope?.excludedRecords).toBe(0);
    } finally {
      await deleteInvestigation(id);
    }
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

  it("refuses a stage while another run holds the lease, and releases it after", async () => {
    const { POST: plan } = await import("../app/api/investigations/[id]/plan/route");
    const { acquireStageLease, clearStageLease } = await import("../lib/store");

    try {
      expect(await acquireStageLease(investigationId, "other-run", 60)).toBe(true);

      const blocked = await plan(post("http://localhost/plan"), context(investigationId));
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error).toMatch(/already running/i);

      // The run that holds the lease may keep running its own stages — the
      // parallel investigators of one pipeline share the worker id.
      const sameRun = await plan(post("http://localhost/plan", { worker: "other-run" }), context(investigationId));
      expect(sameRun.status).toBe(200);
    } finally {
      await clearStageLease(investigationId);
    }

    const released = await plan(post("http://localhost/plan"), context(investigationId));
    expect(released.status).toBe(200);
  });

  /* G-13: closing the tab kills its worker id; reopening the run presents a
     new one. A resume may take over a lease whose holder has gone idle (the
     old tab is gone), but never one that renewed recently (it may be alive). */
  it("a resume takes over an idle lease, never a fresh one", async () => {
    const { acquireStageLease, clearStageLease } = await import("../lib/store");
    const { getPool } = await import("../lib/db/pool");
    const sql = getPool();

    try {
      expect(await acquireStageLease(investigationId, "dead-tab", 60)).toBe(true);

      // Fresh foreign lease: a resume must still be refused.
      expect(
        await acquireStageLease(investigationId, "new-tab", 60, { resume: true, idleSeconds: 20 }),
      ).toBe(false);

      // The holder stopped renewing longer ago than the idle window: gone.
      // The lease is still in the future for the plain rule — only the
      // resume rule may take it over.
      await sql`
        update investigations
        set lease = jsonb_set(lease, '{expiresAt}', to_jsonb((now() + interval '30 seconds')::text))
        where id = ${investigationId}
      `;
      expect(
        await acquireStageLease(investigationId, "new-tab", 60, { resume: true, idleSeconds: 20 }),
      ).toBe(true);

      // The taken-over lease is fresh again: plain starts stay refused.
      expect(await acquireStageLease(investigationId, "third-tab", 60)).toBe(false);
    } finally {
      await clearStageLease(investigationId);
    }
  });

  it("sweeps a stage stuck in running and surfaces it as an error", async () => {
    const { upsertStage, getStages } = await import("../lib/store");
    const { getPool } = await import("../lib/db/pool");
    const sql = getPool();

    await upsertStage(investigationId, "verify", 1, "running");
    await sql`update stages set started_at = now() - interval '10 minutes' where investigation_id = ${investigationId} and stage = 'verify'`;

    const stages = await getStages(investigationId);
    const swept = stages.find((stage) => stage.stage === "verify");
    expect(swept?.status).toBe("error");
    expect(swept?.error).toMatch(/killed|no completion/i);
  });

  it("persists learned anchors from a confirmed scope and re-uses them", async () => {
    const { createInvestigation, insertEvents, getLearnedScope, setScope, deleteInvestigation } =
      await import("../lib/store");
    const { getPool } = await import("../lib/db/pool");
    const sql = getPool();
    // Clear anything learned for this client from earlier runs.
    await sql`delete from learned_scopes where declared_client = 'northwind logistics'`;

    const id = await createInvestigation({
      title: `Learn ${randomUUID()}`,
      escalationText: "Northwind Logistics escalation about Meridian Billing ticket MER-101.",
      contentHash: `hash-${randomUUID()}`,
      declaredClient: "Northwind Logistics",
    });
    created.push(id);
    await insertEvents(id, [
      {
        id: "e_learn_bridge",
        source: "slack",
        ts: "2024-09-20T09:00:00.000Z",
        actor: "Marcus Webb",
        channel: "meridian-billing",
        text: "Northwind escalation (MER-101): fix is scheduled.",
        refs: ["MER-101"],
      },
    ]);

    try {
      // Pass 1: the model cooperates and the scope confirms.
      const scripted = await import("../lib/llm");
      scripted.setLlmClientForTests({
        chat: async (messages) => {
          const system = messages[0]?.content ?? "";
          if (system.includes("issue analyst")) return { content: "plan" };
          if (system.includes("identify which client and project")) {
            return {
              content: JSON.stringify({
                client: "Northwind Logistics",
                project: "Meridian Billing",
                ticketPrefixes: ["MER"],
                channels: ["meridian-billing"],
                senderDomains: ["northwind.example"],
              }),
            };
          }
          if (system.includes("skeptic")) return { content: JSON.stringify({ issues: [] }) };
          if (system.includes("one claim against one quote")) return { content: '{"supports":"yes"}' };
          if (messages.some((message) => message.role === "tool")) return { content: '{"claims":[],"notes":[]}' };
          return { content: "" };
        },
      });

      const { POST: plan } = await import("../app/api/investigations/[id]/plan/route");
      const first = await plan(post("http://localhost/plan"), context(id));
      expect(first.status).toBe(200);
      const firstScope = (await first.json()) as { scope?: { confidence?: string } };
      expect(firstScope.scope?.confidence).toBe("scoped");
      expect((await getLearnedScope("Northwind Logistics"))?.ticketPrefixes).toEqual(["MER"]);

      // Pass 2: wipe the scope and have the model propose NOTHING — the
      // learned anchors must carry the resolution.
      await setScope(id, null);
      scripted.setLlmClientForTests({
        chat: async (messages) => {
          const system = messages[0]?.content ?? "";
          if (system.includes("issue analyst")) return { content: "plan" };
          if (system.includes("identify which client and project")) return { content: "{}" };
          if (system.includes("skeptic")) return { content: JSON.stringify({ issues: [] }) };
          if (system.includes("one claim against one quote")) return { content: '{"supports":"yes"}' };
          if (messages.some((message) => message.role === "tool")) return { content: '{"claims":[],"notes":[]}' };
          return { content: "" };
        },
      });

      const second = await plan(post("http://localhost/plan"), context(id));
      const secondScope = (await second.json()) as {
        scope?: { confidence?: string; ticketPrefixes?: string[]; channels?: string[] };
      };
      expect(secondScope.scope?.ticketPrefixes).toEqual(["MER"]);
      expect(secondScope.scope?.channels).toEqual(["meridian-billing"]);
    } finally {
      await sql`delete from learned_scopes where declared_client = 'northwind logistics'`;
      await deleteInvestigation(id);
    }
  });

  it("serves complete:false for an investigation whose pipeline has not run", async () => {
    const { createInvestigation } = await import("../lib/store");
    const { GET: resultRoute } = await import("../app/api/investigations/[id]/result/route");

    const freshId = await createInvestigation({
      title: `Fresh ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(freshId);

    const response = await resultRoute(
      new NextRequest("http://localhost/result"),
      context(freshId),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).complete).toBe(false);
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
    expect(resultBody.complete).toBe(true);
    expect(resultBody.investigation.origin).toBe("upload");

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
