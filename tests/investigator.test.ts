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
                text: "The 4.12 timezone change shipped on Sep 10 and caused the totals defect.",
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

  it("rejects an unknown investigator kind", async () => {
    const { runInvestigator } = await import("../lib/agents/investigator");
    await expect(
      // @ts-expect-error deliberately invalid kind
      runInvestigator(investigationId, "vibes", "plan"),
    ).rejects.toThrow(/unknown investigator kind/i);
  });
});
