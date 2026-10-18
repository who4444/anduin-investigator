import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";
import type { LlmClient, LlmResponse } from "../lib/llm";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const jiraId = "e_investigator_0001";
const slackId = "e_investigator_0002";

function scriptedClient(responses: LlmResponse[]): LlmClient {
  let call = 0;
  return {
    chat: async (): Promise<LlmResponse> => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return response;
    },
  };
}

describeDb("runInvestigator", () => {
  let investigationId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const { createInvestigation, insertEvents } = await import("../lib/store");
    investigationId = await createInvestigation({
      title: `Investigator ${randomUUID()}`,
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
        text: "Timezone change for release 4.12 shipped on Sep 10.",
      },
      {
        id: slackId,
        source: "slack",
        ts: "2024-09-26T09:00:00.000Z",
        actor: "Marcus Webb",
        channel: "meridian-billing",
        text: "Marking MER-101 resolved, fix is in the Sep 24 build.",
      },
    ]);
  });

  afterAll(async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    setLlmClientForTests(null);
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) {
      await deleteInvestigation(id);
    }
  });

  it("persists tool-submitted claims, final-JSON claims, and notes as gaps", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");
    const { getClaims, getStages, getEvents } = await import("../lib/store");
    const { getPool } = await import("../lib/db/pool");

    setLlmClientForTests(
      scriptedClient([
        {
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "submit_claim",
              args: {
                type: "root_cause",
                text: "The 4.12 timezone change shipped on Sep 10.",
                quote: "Timezone change for release 4.12 shipped on Sep 10.",
                event_id: jiraId,
                status: "n/a",
                confidence: 0.92,
              },
            },
          ],
        },
        {
          content: JSON.stringify({
            claims: [
              {
                type: "process_failure",
                text: "The ticket was resolved while the fix had not shipped.",
                quote: "fix is in the Sep 24 build",
                event_id: slackId,
                status: "n/a",
                confidence: 0.8,
              },
            ],
            notes: ["No record shows when the Sep 24 release actually went out."],
          }),
        },
      ]),
    );

    const result = await runInvestigator(
      investigationId,
      "root_cause",
      "1. Reconstruct the timeline.",
    );

    expect(result.claims).toHaveLength(2);
    expect(result.claims.every((claim) => claim.agent === "root_cause")).toBe(true);
    expect(result.log.map((entry) => entry.name)).toEqual(["submit_claim"]);

    const claims = await getClaims(investigationId);
    expect(claims).toHaveLength(2);

    const sql = getPool();
    const gaps = await sql<{ question: string; note: string }[]>`
      select question, note from gaps where investigation_id = ${investigationId}
    `;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].note).toMatch(/Sep 24 release/);

    const stages = await getStages(investigationId);
    const stage = stages.find((entry) => entry.stage === "root_cause");
    expect(stage).toMatchObject({ stage: "root_cause", pass: 1 });
    expect(stage?.log).toHaveLength(1);

    // Sanity: the cited events still exist so quotes can be verified later.
    expect((await getEvents(investigationId)).length).toBe(2);
  });

  it("does not duplicate a claim repeated in the final JSON", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");
    const { getClaims } = await import("../lib/store");

    const submitted = {
      type: "commitment",
      text: "A fix was promised for the Sep 24 build.",
      quote: "fix is in the Sep 24 build",
      event_id: slackId,
      status: "broken",
      confidence: 0.7,
    };

    setLlmClientForTests(
      scriptedClient([
        { content: "", toolCalls: [{ id: "call_1", name: "submit_claim", args: submitted }] },
        { content: JSON.stringify({ claims: [submitted], notes: [] }) },
      ]),
    );

    const result = await runInvestigator(investigationId, "commitments", "1. List promises.");

    expect(result.claims).toHaveLength(1);
    expect((await getClaims(investigationId)).filter((claim) => claim.agent === "commitments")).toHaveLength(1);
  });

  it("forces a final structured reply when the tool budget runs out before any claim", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");
    const { getClaims } = await import("../lib/store");

    let calls = 0;
    setLlmClientForTests({
      chat: async () => {
        calls += 1;
        if (calls <= 10) {
          return {
            content: "",
            toolCalls: [
              { id: `call_${calls}`, name: "search_jira", args: { query: "timezone" } },
            ],
          };
        }
        return {
          content: JSON.stringify({
            claims: [
              {
                type: "root_cause",
                text: "The 4.12 timezone change shipped on Sep 10.",
                quote: "Timezone change for release 4.12 shipped on Sep 10.",
                event_id: jiraId,
                status: "n/a",
                confidence: 0.7,
              },
            ],
            notes: ["The record does not show when the fix actually shipped."],
          }),
        };
      },
    });

    const result = await runInvestigator(investigationId, "root_cause", "1. Reconstruct the timeline.");

    expect(calls).toBe(11); // 10 tool rounds, then one forced structured reply
    expect(result.claims.some((claim) => claim.text === "The 4.12 timezone change shipped on Sep 10.")).toBe(true);
    expect((await getClaims(investigationId)).some((claim) => claim.text.includes("timezone change shipped"))).toBe(true);
  });

  it("gives a budget-exhausted investigator a submission-only phase", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");
    const { getClaims } = await import("../lib/store");

    let calls = 0;
    let harvestCalls = 0;
    let submitted = false;
    setLlmClientForTests({
      chat: async (_messages, opts) => {
        calls += 1;
        const toolNames = (opts?.tools ?? []).map((tool) => tool.function.name);
        const canSearch = toolNames.includes("search_jira");
        if (canSearch) {
          return {
            content: "",
            toolCalls: [{ id: `search_${calls}`, name: "search_jira", args: { query: "timezone" } }],
          };
        }
        harvestCalls += 1;
        if (!submitted) {
          submitted = true;
          return {
            content: "",
            toolCalls: [
              {
                id: "submit_1",
                name: "submit_claim",
                args: {
                  type: "root_cause",
                  text: "Budget-exhausted submission survived.",
                  quote: "Timezone change for release 4.12 shipped on Sep 10.",
                  event_id: jiraId,
                  status: "n/a",
                  confidence: 0.8,
                },
              },
            ],
          };
        }
        return { content: JSON.stringify({ claims: [], notes: [] }) };
      },
    });

    const result = await runInvestigator(investigationId, "root_cause", "1. Reconstruct the timeline.");

    expect(harvestCalls).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(10);
    expect(
      result.claims.some((claim) => claim.text === "Budget-exhausted submission survived."),
    ).toBe(true);
    expect(
      (await getClaims(investigationId)).some(
        (claim) => claim.text === "Budget-exhausted submission survived.",
      ),
    ).toBe(true);
  });

  it("keeps a final-JSON claim with a bad ts by dropping the ts, not the claim", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");
    const { getClaims } = await import("../lib/store");

    setLlmClientForTests(
      scriptedClient([
        {
          content: JSON.stringify({
            claims: [
              {
                type: "process_failure",
                text: "Claim with garbage ts.",
                quote: "fix is in the Sep 24 build",
                event_id: slackId,
                ts: "Sept 24",
                status: "n/a",
                confidence: 0.6,
              },
              {
                type: "process_failure",
                text: "Claim with naive ts.",
                quote: "fix is in the Sep 24 build",
                event_id: slackId,
                ts: "2024-09-26 09:00:00",
                status: "n/a",
                confidence: 0.6,
              },
              {
                type: "process_failure",
                text: "Claim with date-only ts.",
                quote: "fix is in the Sep 24 build",
                event_id: slackId,
                ts: "2024-09-26",
                status: "n/a",
                confidence: 0.6,
              },
            ],
            notes: [],
          }),
        },
        { content: "" },
      ]),
    );

    await runInvestigator(investigationId, "ownership", "1. Process failures.");

    const claims = (await getClaims(investigationId)).filter((claim) => claim.agent === "ownership");
    expect(claims.map((claim) => claim.text)).toEqual(
      expect.arrayContaining([
        "Claim with garbage ts.",
        "Claim with naive ts.",
        "Claim with date-only ts.",
      ]),
    );
    const byText = new Map(claims.map((claim) => [claim.text, claim]));
    expect(byText.get("Claim with garbage ts.")?.ts ?? null).toBeNull();
    expect(byText.get("Claim with naive ts.")?.ts ?? null).toBeNull();
    expect(byText.get("Claim with date-only ts.")?.ts).toBe("2024-09-26T00:00:00.000Z");
  });

  it("does not lose final claims when a forced reply is appended after a parseable object", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");
    const { getClaims } = await import("../lib/store");

    const finalJson = JSON.stringify({
      claims: [
        {
          type: "process_failure",
          text: "Concatenation survivor claim.",
          quote: "fix is in the Sep 24 build",
          event_id: slackId,
          status: "n/a",
          confidence: 0.6,
        },
      ],
      notes: [],
    });
    setLlmClientForTests(
      scriptedClient([
        { content: finalJson },
        { content: '{"claims":[],"notes":[]}' },
      ]),
    );

    await runInvestigator(investigationId, "ownership", "1. Process failures.");

    const claims = (await getClaims(investigationId)).filter((claim) => claim.agent === "ownership");
    expect(claims.some((claim) => claim.text === "Concatenation survivor claim.")).toBe(true);
  });

  it("does not duplicate gaps when the same investigator re-runs", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");
    const { getPool } = await import("../lib/db/pool");

    const finalJson = JSON.stringify({
      claims: [],
      notes: ["No record shows who owned the Sep 24 release decision."],
    });
    setLlmClientForTests(scriptedClient([{ content: finalJson }]));

    await runInvestigator(investigationId, "ownership", "1. Ownership.");
    const sql = getPool();
    const afterFirst = await sql<{ count: string }[]>`
      select count(*)::text as count from gaps where investigation_id = ${investigationId}
    `;
    await runInvestigator(investigationId, "ownership", "1. Ownership.");
    const afterSecond = await sql<{ count: string }[]>`
      select count(*)::text as count from gaps where investigation_id = ${investigationId}
    `;
    expect(afterSecond[0].count).toBe(afterFirst[0].count);
  });

  it("feeds the vocabulary digest to investigators", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");

    let seenUserPrompt = "";
    setLlmClientForTests({
      chat: async (messages) => {
        seenUserPrompt = messages.map((message) => message.content ?? "").join("\n");
        return { content: JSON.stringify({ claims: [], notes: [] }) };
      },
    });

    await runInvestigator(investigationId, "root_cause", "1. Reconstruct the timeline.");

    expect(seenUserPrompt).toContain("Vocabulary observed in the records");
    expect(seenUserPrompt).toContain("MER-101");
  });

  it("merges the forced reply instead of concatenating unparseable fragments", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");
    const { getClaims } = await import("../lib/store");

    const finalJson = JSON.stringify({
      claims: [],
      notes: ["Nothing certain yet."],
    });
    setLlmClientForTests(
      scriptedClient([
        // Stray braces in the loop content: concatenation would break parsing.
        { content: `Here is what I saw { note: partial }.\n${finalJson}` },
        {
          content: JSON.stringify({
            claims: [
              {
                type: "process_failure",
                text: "Forced reply survivor claim.",
                quote: "fix is in the Sep 24 build",
                event_id: slackId,
                status: "n/a",
                confidence: 0.6,
              },
            ],
            notes: ["Forced reply note."],
          }),
        },
      ]),
    );

    await runInvestigator(investigationId, "ownership", "1. Process failures.");

    const claims = (await getClaims(investigationId)).filter((claim) => claim.agent === "ownership");
    expect(claims.some((claim) => claim.text === "Forced reply survivor claim.")).toBe(true);
  });

  it("rejects an unknown investigator kind", async () => {
    const { runInvestigator } = await import("../lib/agents/investigator");
    await expect(
      // @ts-expect-error deliberately invalid kind
      runInvestigator(investigationId, "vibes", "plan"),
    ).rejects.toThrow(/unknown investigator kind/i);
  });

  it("records a retry directive's reasons and explicit queries in the stage log and prompt", async () => {
    const { createInvestigation, insertEvents, getStages } = await import("../lib/store");
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runInvestigator } = await import("../lib/agents/investigator");

    const id = await createInvestigation({
      title: `Retry ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(id);
    await insertEvents(id, [
      {
        id: "e_retry_0000001",
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change for release 4.12 shipped on Sep 10.",
      },
    ]);

    const prompts: string[] = [];
    setLlmClientForTests({
      chat: async (messages) => {
        prompts.push(messages.map((message) => message.content ?? "").join("\n"));
        return { content: JSON.stringify({ claims: [], notes: [] }) };
      },
    });

    await runInvestigator(id, "root_cause", "plan", 2, {
      queries: ["search_jira(all)"],
      reasons: ["the jira source was available but never searched"],
    });

    expect(prompts.some((prompt) => prompt.includes("Run these queries explicitly"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("search_jira(all)"))).toBe(true);

    const stage = (await getStages(id)).find(
      (entry) => entry.stage === "root_cause" && entry.pass === 2,
    );
    const entry = (stage?.log[stage.log.length - 1] ?? {}) as {
      retry?: { reasons?: string[]; queries?: string[] };
    };
    expect(entry.retry?.queries).toEqual(["search_jira(all)"]);
    expect(entry.retry?.reasons).toEqual(["the jira source was available but never searched"]);
  });
});
