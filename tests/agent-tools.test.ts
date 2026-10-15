import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("agent tools", () => {
  let investigationId: string;
  let buildAgentTools: typeof import("../lib/agents/tools").buildAgentTools;
  const created: string[] = [];

  const jiraId = "e_test_jira_0001";
  const slackId = "e_test_slack_0001";

  beforeAll(async () => {
    const { createInvestigation, insertEvents } = await import("../lib/store");
    ({ buildAgentTools } = await import("../lib/agents/tools"));

    investigationId = await createInvestigation({
      title: `Tools ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(investigationId);

    await insertEvents(investigationId, [
      {
        id: jiraId,
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change merged in release 4.12 caused invoice totals to be wrong.",
        threadId: "MER-101",
      },
      {
        id: slackId,
        source: "slack",
        ts: "2024-09-25T09:00:00.000Z",
        actor: "Lin Chen",
        channel: "meridian-billing",
        text: "QA still failing on the Sep 24 build; not shipped.",
        threadId: "slack:meridian-billing:1727000000.000100",
      },
      {
        id: "e_test_slack_0002",
        source: "slack",
        ts: "2024-09-25T09:05:00.000Z",
        actor: "Marcus Webb",
        channel: "meridian-billing",
        text: "Let us keep this open until the fix ships.",
        threadId: "slack:meridian-billing:1727000000.000100",
      },
    ]);
  });

  afterAll(async () => {
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) {
      await deleteInvestigation(id);
    }
  });

  it("search_events filters by query and returns compact events", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(
      await tools.exec("search_events", { query: "timezone" }),
    ) as { count: number; events: { id: string; text: string }[] };

    expect(result.count).toBe(1);
    expect(result.events[0].id).toBe(jiraId);
  });

  it("search_events filters by actor and source", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(
      await tools.exec("search_events", { query: "", actor: "Marcus", source: "slack" }),
    ) as { count: number; events: { actor: string }[] };

    expect(result.count).toBe(1);
    expect(result.events[0].actor).toBe("Marcus Webb");
  });

  it("get_event returns the full text and get_thread returns the conversation", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");

    const event = JSON.parse(await tools.exec("get_event", { id: slackId })) as { text: string };
    expect(event.text).toContain("QA still failing");

    const thread = JSON.parse(await tools.exec("get_thread", { id: slackId })) as {
      events: { id: string }[];
    };
    expect(thread.events.map((entry) => entry.id)).toEqual([slackId, "e_test_slack_0002"]);
  });

  it("verify_quote reports ok for a real substring and an error otherwise", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");

    const ok = JSON.parse(
      await tools.exec("verify_quote", { event_id: jiraId, quote: "release 4.12" }),
    ) as { ok: boolean };
    expect(ok.ok).toBe(true);

    const bad = JSON.parse(
      await tools.exec("verify_quote", { event_id: jiraId, quote: "release 9.99" }),
    ) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("quote_not_found");

    const missing = JSON.parse(
      await tools.exec("verify_quote", { event_id: "e_nope", quote: "x" }),
    ) as { ok: boolean; error?: string };
    expect(missing.error).toBe("event_not_found");
  });

  it("submit_claim persists a claim for the agent", async () => {
    const tools = buildAgentTools(investigationId, "commitments");
    const response = JSON.parse(
      await tools.exec("submit_claim", {
        type: "commitment",
        text: "Fix was promised for the Sep 24 release.",
        quote: "not shipped",
        event_id: slackId,
        ts: "2024-09-25T09:00:00.000Z",
        status: "broken",
        confidence: 0.9,
      }),
    ) as { claimId?: string };

    expect(response.claimId).toMatch(/^[0-9a-f-]{36}$/);

    const { getClaims } = await import("../lib/store");
    const claims = await getClaims(investigationId);
    expect(claims.some((claim) => claim.agent === "commitments" && claim.status === "broken")).toBe(true);
  });

  it("treats a repeated submit_claim as the same claim", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const args = {
      type: "root_cause",
      text: "A retry-friendly claim.",
      quote: "release 4.12",
      event_id: jiraId,
      status: "n/a",
      confidence: 0.7,
    };

    const first = JSON.parse(await tools.exec("submit_claim", args)) as { claimId: string };
    const second = JSON.parse(await tools.exec("submit_claim", args)) as {
      claimId: string;
      duplicate?: boolean;
    };

    expect(second.claimId).toBe(first.claimId);
    expect(second.duplicate).toBe(true);

    const { getClaims } = await import("../lib/store");
    const matches = (await getClaims(investigationId)).filter(
      (claim) => claim.text === "A retry-friendly claim.",
    );
    expect(matches).toHaveLength(1);
  });

  it("rejects a submit_claim without a valid status", async () => {
    const tools = buildAgentTools(investigationId, "commitments");
    const response = JSON.parse(
      await tools.exec("submit_claim", {
        type: "commitment",
        text: "x",
        quote: "not shipped",
        event_id: slackId,
        status: "maybe",
        confidence: 0.5,
      }),
    ) as { error?: string };

    expect(response.error).toMatch(/status/);
  });
});
