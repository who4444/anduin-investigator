import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("agent tools", () => {
  let investigationId: string;
  let buildAgentTools: typeof import("../lib/agents/tools").buildAgentTools;
  const created: string[] = [];

  const issueId = "e_test_jira_0001";
  const commentId = "e_test_jira_0002";
  const slackId = "e_test_slack_0001";
  const replyId = "e_test_slack_0002";
  const mailId = "e_test_email_0001";
  const replyMailId = "e_test_email_0002";
  const slackThread = "slack:meridian-billing:1727251200.000100";
  const emailThread = "msg-root@northwind.example";

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
        id: issueId,
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change merged for release 4.12.",
        threadId: "MER-101",
      },
      {
        id: commentId,
        source: "jira",
        ts: "2024-09-23T04:00:00.000Z",
        actor: "Marcus Webb",
        channel: "MER-101",
        text: "Fix scheduled for the Sep 24 release.",
        threadId: "MER-101",
      },
      {
        id: slackId,
        source: "slack",
        ts: "2024-09-24T16:00:00.000Z",
        actor: "Marcus Webb",
        channel: "meridian-billing",
        text: "Sep 24 release is cut; invoice fix included.",
        threadId: slackThread,
      },
      {
        id: replyId,
        source: "slack",
        ts: "2024-09-25T09:00:00.000Z",
        actor: "Dana Okoro",
        channel: "meridian-billing",
        text: "QA is still failing on the Sep 24 build.",
        threadId: slackThread,
      },
      {
        id: mailId,
        source: "email",
        ts: "2024-09-20T05:00:00.000Z",
        actor: "L. Chen <l.chen@northwind.example>",
        channel: "email",
        text: "We will ship the fix in the Sep 24 release.",
        threadId: emailThread,
      },
      {
        id: replyMailId,
        source: "email",
        ts: "2024-09-27T03:05:00.000Z",
        actor: "Priya Nair <priya.nair@northwind.example>",
        channel: "email",
        text: "Totals are still wrong this morning.",
        threadId: emailThread,
      },
    ]);
  });

  afterAll(async () => {
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) {
      await deleteInvestigation(id);
    }
  });

  it("search_jira finds issue items by text and can bound by date", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");

    const text = JSON.parse(await tools.exec("search_jira", { query: "Sep 24 release" })) as {
      count: number;
      items: { id: string }[];
    };
    expect(text.count).toBe(1);
    expect(text.items[0].id).toBe(commentId);

    const windowed = JSON.parse(
      await tools.exec("search_jira", { query: "release", from: "2024-09-20T00:00:00.000Z" }),
    ) as { items: { id: string }[] };
    expect(windowed.items.map((item) => item.id)).toEqual([commentId]);
  });

  it("get_issue reads the whole issue in order", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(await tools.exec("get_issue", { key: "MER-101" })) as {
      count: number;
      items: { id: string; text: string }[];
    };

    expect(result.count).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual([issueId, commentId]);

    const missing = JSON.parse(await tools.exec("get_issue", { key: "MER-999" })) as { error?: string };
    expect(missing.error).toMatch(/No stored issue/);
  });

  it("search_slack searches text and channel", async () => {
    const tools = buildAgentTools(investigationId, "commitments");

    const all = JSON.parse(await tools.exec("search_slack", { query: "release" })) as {
      items: { id: string }[];
    };
    expect(all.items.map((item) => item.id)).toEqual([slackId]);

    const byChannel = JSON.parse(
      await tools.exec("search_slack", { query: "", channel: "meridian-billing" }),
    ) as { count: number };
    expect(byChannel.count).toBe(2);

    const otherChannel = JSON.parse(await tools.exec("search_slack", { channel: "general" })) as {
      count: number;
    };
    expect(otherChannel.count).toBe(0);
  });

  it("get_slack_thread reads the thread's items", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(
      await tools.exec("get_slack_thread", { channel: "meridian-billing", ts: "1727251200.000100" }),
    ) as { count: number; items: { id: string }[] };

    expect(result.count).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual([slackId, replyId]);
  });

  it("search_email searches text and sender", async () => {
    const tools = buildAgentTools(investigationId, "commitments");

    const bySender = JSON.parse(await tools.exec("search_email", { sender: "priya" })) as {
      items: { id: string }[];
    };
    expect(bySender.items.map((item) => item.id)).toEqual([replyMailId]);

    const byText = JSON.parse(await tools.exec("search_email", { query: "Sep 24 release" })) as {
      items: { id: string }[];
    };
    expect(byText.items.map((item) => item.id)).toEqual([mailId]);
  });

  it("get_email_thread reads the thread by message id", async () => {
    const tools = buildAgentTools(investigationId, "commitments");
    const result = JSON.parse(
      await tools.exec("get_email_thread", { id: "<msg-root@northwind.example>" }),
    ) as { count: number; items: { id: string }[] };

    expect(result.count).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual([mailId, replyMailId]);
  });

  it("verify_quote reports ok for a real substring and an error otherwise", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");

    const ok = JSON.parse(
      await tools.exec("verify_quote", { item_id: issueId, quote: "release 4.12" }),
    ) as { ok: boolean };
    expect(ok.ok).toBe(true);

    const bad = JSON.parse(
      await tools.exec("verify_quote", { item_id: issueId, quote: "release 9.99" }),
    ) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("quote_not_found");

    const missing = JSON.parse(
      await tools.exec("verify_quote", { item_id: "e_nope", quote: "x" }),
    ) as { ok: boolean; error?: string };
    expect(missing.error).toBe("item_not_found");
  });

  it("submit_claim persists a claim and treats a repeat as the same claim", async () => {
    const tools = buildAgentTools(investigationId, "commitments");
    const args = {
      type: "commitment",
      text: "A fix was promised for the Sep 24 release.",
      quote: "ship the fix in the Sep 24 release",
      item_id: mailId,
      ts: "2024-09-20T05:00:00.000Z",
      status: "broken",
      confidence: 0.9,
    };

    const first = JSON.parse(await tools.exec("submit_claim", args)) as { claimId: string };
    expect(first.claimId).toMatch(/^[0-9a-f-]{36}$/);

    const second = JSON.parse(await tools.exec("submit_claim", args)) as {
      claimId: string;
      duplicate?: boolean;
    };
    expect(second.claimId).toBe(first.claimId);
    expect(second.duplicate).toBe(true);

    const { getClaims } = await import("../lib/store");
    const claims = await getClaims(investigationId);
    expect(
      claims.filter((claim) => claim.text === "A fix was promised for the Sep 24 release."),
    ).toHaveLength(1);
    expect(claims.find((claim) => claim.id === first.claimId)?.eventId).toBe(mailId);
  });

  it("rejects a submit_claim without a valid status", async () => {
    const tools = buildAgentTools(investigationId, "commitments");
    const response = JSON.parse(
      await tools.exec("submit_claim", {
        type: "commitment",
        text: "x",
        quote: "Sep 24 release",
        item_id: mailId,
        status: "maybe",
        confidence: 0.5,
      }),
    ) as { error?: string };

    expect(response.error).toMatch(/status/);
  });
});
