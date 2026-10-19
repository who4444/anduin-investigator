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

    const missing = JSON.parse(await tools.exec("get_issue", { key: "MER-999" })) as {
      error?: string;
      status?: string;
    };
    expect(missing.error).toMatch(/No stored issue/);
    expect(missing.status).toBe("not_in_export");
  });

  it("distinguishes absent sources, excluded keys and empty results (I2)", async () => {
    const { createInvestigation, insertEvents, setScope } = await import("../lib/store");
    const bare = await createInvestigation({
      title: `Tools bare ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(bare);
    await insertEvents(bare, [
      {
        id: "e_test_jira_bare",
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change merged for release 4.12.",
        threadId: "MER-101",
      },
    ]);
    const bareTools = buildAgentTools(bare, "root_cause");

    // The source itself is not part of the export: never a zero-count absence.
    const noSlack = JSON.parse(await bareTools.exec("search_slack", { query: "anything" })) as {
      status?: string;
      count?: number;
    };
    expect(noSlack.status).toBe("not_in_export");
    expect(noSlack.count).toBe(0);

    // The key exists in the registry but is excluded by scope: say so, with an add-back path.
    await setScope(bare, {
      client: "Other Client",
      project: "Other",
      ticketPrefixes: ["OTH"],
      channels: [],
      senderDomains: [],
      confidence: "scoped",
      anchors: [],
    });
    const excluded = JSON.parse(await bareTools.exec("get_issue", { key: "MER-101" })) as {
      status?: string;
      error?: string;
    };
    expect(excluded.status).toBe("excluded_by_scope");
    expect(excluded.error).toMatch(/excluded|add it back/i);

    // The source exists in scope but the query matches nothing: searched, empty.
    const { setScope: clearScope } = await import("../lib/store");
    await clearScope(bare, null);
    const empty = JSON.parse(await bareTools.exec("search_jira", { query: "zzz-no-such-record" })) as {
      status?: string;
      count?: number;
    };
    expect(empty.status).toBe("empty");
    expect(empty.count).toBe(0);

    // A successful search carries an explicit ok status.
    const ok = JSON.parse(await bareTools.exec("search_jira", { query: "4.12" })) as { status?: string };
    expect(ok.status).toBe("ok");
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

  it("get_email_thread reads the thread by message id or by any item id in it", async () => {
    const tools = buildAgentTools(investigationId, "commitments");

    const byMessageId = JSON.parse(
      await tools.exec("get_email_thread", { id: "<msg-root@northwind.example>" }),
    ) as { count: number; items: { id: string }[] };
    expect(byMessageId.count).toBe(2);
    expect(byMessageId.items.map((item) => item.id)).toEqual([mailId, replyMailId]);

    const byItemId = JSON.parse(await tools.exec("get_email_thread", { id: replyMailId })) as {
      count: number;
    };
    expect(byItemId.count).toBe(2);
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
      type: "finding",
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

  it("rejects a submit_claim whose ts is not a real timestamp", async () => {
    const tools = buildAgentTools(investigationId, "commitments");
    const base = {
      type: "finding",
      quote: "ship the fix in the Sep 24 release",
      item_id: mailId,
      status: "broken",
      confidence: 0.9,
    };

    const garbage = JSON.parse(
      await tools.exec("submit_claim", { ...base, text: "Garbage ts promise.", ts: "Sept 24" }),
    ) as { error?: string };
    expect(garbage.error).toMatch(/ts/i);

    const naive = JSON.parse(
      await tools.exec("submit_claim", { ...base, text: "Naive ts promise.", ts: "2024-09-20 05:00:00" }),
    ) as { error?: string };
    expect(naive.error).toMatch(/ts/i);

    const relative = JSON.parse(
      await tools.exec("submit_claim", { ...base, text: "Relative ts promise.", ts: "yesterday" }),
    ) as { error?: string };
    expect(relative.error).toMatch(/ts/i);

    const { getClaims } = await import("../lib/store");
    const texts = (await getClaims(investigationId)).map((claim) => claim.text);
    expect(texts).not.toContain("Garbage ts promise.");
    expect(texts).not.toContain("Naive ts promise.");
    expect(texts).not.toContain("Relative ts promise.");
  });

  it("a search pinned to an excluded target answers excluded, not empty (review I6)", async () => {
    const { createInvestigation, insertEvents, setScope } = await import("../lib/store");
    const id = await createInvestigation({
      title: `Tools excluded-filter ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(id);
    await insertEvents(id, [
      {
        id: "e_test_vertex",
        source: "slack",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Ravi Patel",
        channel: "vertex-billing",
        text: "Vertex rate limits were raised.",
      },
      // A mixed source: another channel IS in scope.
      {
        id: "e_test_scoped_slack",
        source: "slack",
        ts: "2024-09-11T03:00:00.000Z",
        actor: "Dana Okoro",
        channel: "general",
        text: "General room chatter about the fix.",
      },
    ]);
    await setScope(id, {
      client: "Other Client",
      project: "Other",
      ticketPrefixes: ["OTH"],
      channels: ["general"],
      senderDomains: [],
      confidence: "scoped",
      anchors: [],
    });
    try {
      const tools = buildAgentTools(id, "root_cause");
      const pinned = JSON.parse(
        await tools.exec("search_slack", { query: "rate limits", channel: "vertex-billing" }),
      ) as { status?: string; count?: number };
      expect(pinned.status).toBe("excluded_by_scope");
      expect(pinned.count).toBe(0);
    } finally {
      await setScope(id, null);
    }
  });

  it("rejects a claim that asserts more than its quote states (I1)", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const base = {
      type: "root_cause",
      quote: "Merged to 4.12; invoices now use UTC.",
      item_id: issueId,
      status: "n/a",
      confidence: 0.9,
    };

    const causal = JSON.parse(
      await tools.exec("submit_claim", { ...base, text: "The UTC merge is the identified cause of the wrong totals." }),
    ) as { error?: string; claimId?: string };
    expect(causal.error).toMatch(/observation|note/i);
    expect(causal.claimId).toBeUndefined();

    const comparative = JSON.parse(
      await tools.exec("submit_claim", {
        ...base,
        quote: "Status: In Progress → Resolved",
        text: "The ticket was resolved ten days before the real fix landed.",
      }),
    ) as { error?: string };
    expect(comparative.error).toMatch(/observation|note/i);

    const observation = JSON.parse(
      await tools.exec("submit_claim", { ...base, text: "Release 4.12 merged the timezone change." }),
    ) as { claimId?: string; error?: string };
    expect(observation.error, JSON.stringify(observation)).toBeUndefined();
    expect(observation.claimId).toBeDefined();
  });

  it("requires a completeness phrase on negative claims (I1/G-03)", async () => {
    const tools = buildAgentTools(investigationId, "ownership");
    const base = { type: "ownership", item_id: replyId, status: "n/a", confidence: 0.9 };

    const bare = JSON.parse(
      await tools.exec("submit_claim", {
        ...base,
        quote: "Has anyone heard back from Northwind about the totals?",
        text: "The client's chase went unanswered.",
      }),
    ) as { error?: string };
    // Either rejection is honest: the overreach message or the completeness one.
    expect(bare.error).toMatch(/observation|records searched|note/i);

    const proven = JSON.parse(
      await tools.exec("submit_claim", {
        ...base,
        quote: "Has anyone heard back from Northwind about the totals?",
        text: "No reply to the client's chase in the records searched.",
      }),
    ) as { claimId?: string; error?: string };
    expect(proven.error, JSON.stringify(proven)).toBeUndefined();
    expect(proven.claimId).toBeDefined();
  });

  it("normalizes a date-only ts to UTC midnight on a submitted claim", async () => {
    const tools = buildAgentTools(investigationId, "commitments");
    const result = JSON.parse(
      await tools.exec("submit_claim", {
        type: "finding",
        text: "Date-only ts promise.",
        quote: "ship the fix in the Sep 24 release",
        item_id: mailId,
        ts: "2024-09-24",
        status: "unclear",
        confidence: 0.5,
      }),
    ) as { claimId: string };

    const { getClaims } = await import("../lib/store");
    const stored = (await getClaims(investigationId)).find((claim) => claim.id === result.claimId);
    expect(stored?.ts).toBe("2024-09-24T00:00:00.000Z");
  });

  it("treats date-only search bounds as inclusive calendar days", async () => {
    const tools = buildAgentTools(investigationId, "commitments");

    const upper = JSON.parse(await tools.exec("search_slack", { to: "2024-09-24" })) as {
      items: { id: string }[];
    };
    expect(upper.items.map((item) => item.id)).toContain(slackId);

    const day = JSON.parse(
      await tools.exec("search_slack", { from: "2024-09-24", to: "2024-09-24" }),
    ) as { items: { id: string }[] };
    expect(day.items.map((item) => item.id)).toEqual([slackId]);

    const fromTs = JSON.parse(
      await tools.exec("search_slack", { from: "2024-09-24T00:00:00.000Z" }),
    ) as { items: { id: string }[] };
    // An open-ended listing shows the most recent first.
    expect(fromTs.items.map((item) => item.id)).toEqual([replyId, slackId]);
  });

  it("caps get_issue output so a long issue cannot blow the model context", async () => {
    const { insertEvents } = await import("../lib/store");
    const body = "Detail line about the timezone regression. ".repeat(70); // ~3.1k chars
    await insertEvents(
      investigationId,
      Array.from({ length: 45 }, (_, index) => ({
        id: `e_test_big_${String(index).padStart(2, "0")}`,
        source: "jira" as const,
        ts: `2024-09-11T00:00:${String(index).padStart(2, "0")}.000Z`,
        actor: "Lin Chen",
        channel: "MER-BIG",
        text: `${body} (${index})`,
      })),
    );

    const tools = buildAgentTools(investigationId, "root_cause");
    const raw = await tools.exec("get_issue", { key: "MER-BIG" });
    const result = JSON.parse(raw) as { count: number; items: unknown[]; truncated: boolean };

    expect(result.count).toBe(45);
    expect(result.items.length).toBeLessThan(45);
    expect(result.truncated).toBe(true);
    expect(raw.length).toBeLessThan(30_000);
  });

  it("scopes agent tools to the investigation's client and project", async () => {
    const { setScope, insertEvents: insert } = await import("../lib/store");
    await insert(investigationId, [
      {
        id: "e_test_kst",
        source: "jira",
        ts: "2024-09-12T03:00:00.000Z",
        actor: "Ravi Patel",
        channel: "KST-301",
        text: "Acme rate limits were raised.",
      },
      {
        id: "e_test_kestrel",
        source: "slack",
        ts: "2024-09-12T04:00:00.000Z",
        actor: "Ravi Patel",
        channel: "kestrel-eng",
        text: "Acme's Kestrel change is live.",
      },
      {
        id: "e_test_acme_mail",
        source: "email",
        ts: "2024-09-12T05:00:00.000Z",
        actor: "Ravi Patel <ravi@acme.example>",
        channel: "email",
        text: "Acme's rate limits were raised; closing KST-301.",
      },
    ]);
    await setScope(investigationId, {
      client: "Northwind Logistics",
      project: "Meridian Billing",
      ticketPrefixes: ["MER"],
      channels: ["meridian-billing"],
      senderDomains: ["northwind.example"],
      confidence: "scoped",
      anchors: [],
    });

    try {
      const tools = buildAgentTools(investigationId, "root_cause");

      const jira = JSON.parse(await tools.exec("search_jira", { query: "" })) as {
        items: { channel: string }[];
      };
      expect(jira.items.every((item) => item.channel.startsWith("MER"))).toBe(true);

      const slack = JSON.parse(await tools.exec("search_slack", { query: "" })) as {
        items: { channel: string }[];
      };
      expect(slack.items.every((item) => item.channel === "meridian-billing")).toBe(true);

      const email = JSON.parse(await tools.exec("search_email", { query: "" })) as {
        items: { actor: string }[];
      };
      expect(email.items.every((item) => item.actor.includes("northwind.example"))).toBe(true);

      const kst = JSON.parse(await tools.exec("get_issue", { key: "KST-301" })) as {
        error?: string;
        status?: string;
      };
      // I2: the key exists in the registry but is scoped away — an add-back,
      // never a phony "not stored" or a scope guess about another client.
      expect(kst.status).toBe("excluded_by_scope");
      expect(kst.error).toMatch(/excluded by this investigation's scope/);
    } finally {
      await setScope(investigationId, null);
    }
  });

  it("surfaces a client message posted in a shared channel (G-01 recall guard)", async () => {
    const { createInvestigation, insertEvents, setScope } = await import("../lib/store");
    const id = await createInvestigation({
      title: `Tools chase ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(id);

    await insertEvents(id, [
      // The client chases in the vendor's shared room; the identity link is
      // the actor's own address (the same signal identity resolution fills
      // in via actor_resolved at ingest).
      {
        id: "e_chase_general",
        source: "slack",
        ts: "2024-09-26T09:00:00.000Z",
        actor: "Dana Okoro <dana.okafor@northwind.example>",
        channel: "general",
        text: "Northwind here — invoice totals are still wrong. Anyone?",
      },
      {
        id: "e_noise_foreign",
        source: "slack",
        ts: "2024-09-25T09:00:00.000Z",
        actor: "Ravi Patel <ravi@acme.example>",
        channel: "kestrel-eng",
        text: "Acme deploy done.",
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

    try {
      const tools = buildAgentTools(id, "root_cause");
      const slack = JSON.parse(await tools.exec("search_slack", { query: "" })) as {
        items: { id: string; channel: string }[];
      };
      const ids = slack.items.map((item) => item.id);
      expect(ids).toContain("e_chase_general");
      // Another tenant's channel stays hidden.
      expect(ids).not.toContain("e_noise_foreign");
    } finally {
      await setScope(id, null);
    }
  });

  it("returns the on-point record first instead of the oldest matches", async () => {
    const { insertEvents } = await import("../lib/store");
    const filler = Array.from({ length: 35 }, (_, index) => ({
      id: `e_rank_fill_${String(index).padStart(2, "0")}`,
      source: "slack" as const,
      ts: `2024-09-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      actor: "Lin Chen",
      channel: "meridian-billing",
      text: "Invoice totals review note: fix needed later.",
    }));
    await insertEvents(investigationId, [
      ...filler,
      {
        id: "e_rank_point",
        source: "slack" as const,
        ts: "2024-09-30T00:00:00.000Z", // newest — chronological truncation would drop it
        actor: "Priya Nair",
        channel: "meridian-billing",
        text: "The invoice fix shipped in the Sep 24 build (MER-202); please verify totals.",
      },
    ]);

    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(await tools.exec("search_slack", { query: "invoice" })) as {
      count: number;
      items: { id: string }[];
      truncated: boolean;
    };

    expect(result.count).toBeGreaterThan(30);
    expect(result.truncated).toBe(true);
    expect(result.items.map((item) => item.id)).toContain("e_rank_point");
    expect(result.items[0].id).toBe("e_rank_point");
  });

  it("matches a query that only appears in a record's ticket references", async () => {
    const { insertEvents } = await import("../lib/store");
    await insertEvents(investigationId, [
      {
        id: "e_ref_only",
        source: "slack",
        ts: "2024-09-14T00:00:00.000Z",
        actor: "Marcus Webb",
        channel: "meridian-billing",
        text: "Covered in the linked ticket.",
        refs: ["KST-999"],
      },
    ]);

    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(await tools.exec("search_slack", { query: "KST-999" })) as {
      items: { id: string }[];
    };
    expect(result.items.map((item) => item.id)).toContain("e_ref_only");
  });

  it("lists newest-first when the query is empty", async () => {
    const { insertEvents } = await import("../lib/store");
    await insertEvents(investigationId, [
      {
        id: "e_order_old",
        source: "slack",
        ts: "2024-09-01T00:00:00.000Z",
        actor: "Marcus Webb",
        channel: "order-check",
        text: "oldest note",
      },
      {
        id: "e_order_new",
        source: "slack",
        ts: "2024-09-28T00:00:00.000Z",
        actor: "Marcus Webb",
        channel: "order-check",
        text: "newest note",
      },
    ]);

    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(await tools.exec("search_slack", { channel: "order-check" })) as {
      items: { id: string }[];
    };
    expect(result.items.map((item) => item.id)).toEqual(["e_order_new", "e_order_old"]);
  });

  it("honors a window bound written without milliseconds", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(
      await tools.exec("search_jira", { query: "release 4.12", from: "2024-09-10T03:00:00Z" }),
    ) as { items: { id: string }[] };
    // The jira fixture event sits exactly at 2024-09-10T03:00:00.000Z — the
    // no-millisecond bound must not exclude it.
    expect(result.items.map((item) => item.id)).toContain(issueId);
  });

  it("falls back to the channel when the model omits the thread ts", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(
      await tools.exec("get_slack_thread", { channel: "meridian-billing" }),
    ) as { count: number; note?: string };

    expect(result.count).toBeGreaterThan(0);
    expect(result.note).toContain("No thread ts was given");
  });

  it("resolves what the model actually passes: an item id or an ISO ts", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");

    const byId = JSON.parse(
      await tools.exec("get_slack_thread", { channel: "meridian-billing", ts: slackId }),
    ) as { count: number; items: { id: string }[] };
    expect(byId.items.map((item) => item.id)).toEqual([slackId, replyId]);

    const byIso = JSON.parse(
      await tools.exec("get_slack_thread", { channel: "meridian-billing", ts: "2024-09-24T16:00:00.000Z" }),
    ) as { count: number; items: { id: string }[] };
    expect(byIso.items.map((item) => item.id)).toEqual([slackId, replyId]);
  });

  it("falls back to the channel instead of failing on an unmatched ts", async () => {
    const tools = buildAgentTools(investigationId, "root_cause");
    const result = JSON.parse(
      await tools.exec("get_slack_thread", { channel: "meridian-billing", ts: "not-epoch" }),
    ) as { count: number; note?: string; error?: string; items?: { id: string }[] };
    expect(result.error).toBeUndefined();
    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(result.items?.map((item) => item.id)).toContain(slackId);
    expect(result.note).toContain('No stored thread matched ts "not-epoch"');
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
