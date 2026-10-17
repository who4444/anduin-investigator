import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("runAnalyst", () => {
  let investigationId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const { createInvestigation, insertEvents } = await import("../lib/store");
    investigationId = await createInvestigation({
      title: `Analyst ${randomUUID()}`,
      escalationText: "Client says invoice totals are wrong since the 4.12 release.",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(investigationId);

    await insertEvents(investigationId, [
      {
        id: "e_analyst_0000001",
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change caused invoice totals to be wrong.",
      },
      {
        id: "e_analyst_0000002",
        source: "email",
        ts: "2024-09-27T01:00:00.000Z",
        actor: "Priya Nair",
        channel: "email",
        text: "Any update on the totals issue?",
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

  it("stores a rendered structured plan with its JSON and feeds the vocabulary digest", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runAnalyst } = await import("../lib/agents/analyst");
    const { getInvestigation, getStages } = await import("../lib/store");

    const structured = {
      framing: "Trace 4.12 to the invoice totals.",
      hypotheses: [
        {
          statement: "The 4.12 timezone change caused the drift.",
          test: "Compare totals around Sep 10.",
          falsify: "Totals unchanged across the deploy.",
        },
      ],
      sources: [{ source: "jira", approach: "Read MER-101 first." }],
      searchTerms: ["invoice", "totals"],
      people: ["Priya Nair"],
      dateWindow: { from: "2024-09-01", to: null },
      unknowns: ["Who approved the release?"],
    };

    let seenUserPrompt = "";
    setLlmClientForTests({
      chat: async (messages) => {
        seenUserPrompt = messages.map((message) => message.content ?? "").join("\n");
        return { content: JSON.stringify(structured) };
      },
    });

    const plan = await runAnalyst(investigationId, "Client says totals are wrong since 4.12.");

    expect(plan).toContain("Trace 4.12 to the invoice totals.");
    expect(plan).toContain("The 4.12 timezone change caused the drift.");
    expect(plan).toContain("Focus window: from 2024-09-01");

    const stored = await getInvestigation(investigationId);
    expect(stored?.plan).toBe(plan);
    expect(stored?.planData?.hypotheses[0].statement).toContain("timezone change");
    expect(stored?.planData?.dateWindow).toEqual({ from: "2024-09-01", to: null });

    expect(seenUserPrompt).toContain("Vocabulary observed in the records");
    expect(seenUserPrompt).toContain("MER-101");
    expect(seenUserPrompt).toContain("Reply with JSON only");

    const stages = await getStages(investigationId);
    const planStage = stages.find((stage) => stage.stage === "plan");
    expect(planStage).toMatchObject({ stage: "plan", pass: 1 });
    expect(planStage?.log).toHaveLength(1);
    expect(JSON.stringify(planStage?.log)).toContain('"structured":true');
  });

  it("degrades to free text when the model returns prose", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runAnalyst } = await import("../lib/agents/analyst");
    const { getInvestigation } = await import("../lib/store");

    setLlmClientForTests({
      chat: async () => ({ content: "1. Reconstruct the timeline." }),
    });

    const plan = await runAnalyst(investigationId, "");

    expect(plan).toBe("1. Reconstruct the timeline.");
    const stored = await getInvestigation(investigationId);
    expect(stored?.plan).toBe("1. Reconstruct the timeline.");
    expect(stored?.planData).toBeNull();
  });

  it("infers the escalation when none is supplied", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runAnalyst } = await import("../lib/agents/analyst");

    let seenUserPrompt = "";
    setLlmClientForTests({
      chat: async (messages) => {
        seenUserPrompt = messages.map((message) => message.content ?? "").join("\n");
        return { content: "plan" };
      },
    });

    await runAnalyst(investigationId, "");

    expect(seenUserPrompt).toMatch(/no escalation text was provided/i);
  });
});
