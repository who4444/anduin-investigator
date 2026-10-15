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

  it("returns the model plan, stores it, and logs the stage", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runAnalyst } = await import("../lib/agents/analyst");
    const { getInvestigation, getStages } = await import("../lib/store");

    const planText = "1. Reconstruct the timeline.\n2. Locate the introducing change.";
    let seenUserPrompt = "";
    setLlmClientForTests({
      chat: async (messages) => {
        seenUserPrompt = messages.map((message) => message.content ?? "").join("\n");
        return { content: planText };
      },
    });

    const plan = await runAnalyst(investigationId, "Client says totals are wrong since 4.12.");

    expect(plan).toBe(planText);
    expect((await getInvestigation(investigationId))?.plan).toBe(planText);
    expect(seenUserPrompt).toContain("Client says totals are wrong since 4.12.");

    const stages = await getStages(investigationId);
    const planStage = stages.find((stage) => stage.stage === "plan");
    expect(planStage).toMatchObject({ stage: "plan", pass: 1 });
    expect(planStage?.log).toHaveLength(1);
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
