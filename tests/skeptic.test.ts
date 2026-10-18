import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";
import type { LlmClient } from "../lib/llm";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("runSkeptic", () => {
  let investigationId: string;
  const created: string[] = [];
  const eventId = "e_skeptic_0000001";

  beforeAll(async () => {
    const { createInvestigation, insertEvents, insertClaims } = await import("../lib/store");
    investigationId = await createInvestigation({
      title: `Skeptic ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(investigationId);

    await insertEvents(investigationId, [
      {
        id: eventId,
        source: "jira",
        ts: "2024-09-26T03:00:00.000Z",
        actor: "Marcus Webb",
        channel: "MER-101",
        text: "Marking MER-101 resolved; the fix shipped in the Sep 24 build.",
      },
      {
        id: "e_skeptic_0000002",
        source: "slack",
        ts: "2024-09-25T09:00:00.000Z",
        actor: "Lin Chen",
        channel: "meridian-billing",
        text: "QA is still failing on the Sep 24 build.",
      },
    ]);

    await insertClaims(investigationId, [
      {
        agent: "root_cause",
        type: "root_cause",
        text: "The fix shipped in the Sep 24 build.",
        quote: "the fix shipped in the Sep 24 build",
        eventId,
        status: "n/a",
        confidence: 0.9,
      },
      {
        agent: "commitments",
        type: "commitment",
        text: "A fix was promised for Sep 24.",
        quote: "the fix shipped in the Sep 24 build",
        eventId,
        status: "kept",
        confidence: 0.8,
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

  it("flags the contradicted claim and records silence notes as gaps", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runSkeptic } = await import("../lib/agents/skeptic");
    const { getClaims, getGaps, getSkepticNotes, getStages } = await import("../lib/store");

    let seenUserPrompt = "";
    const client: LlmClient = {
      chat: async (messages) => {
        seenUserPrompt = messages.map((message) => message.content ?? "").join("\n");
        return {
          content: JSON.stringify({
            issues: [
              {
                kind: "contradiction",
                claim_index: 0,
                text: "MER-101 was marked resolved while QA was still failing the same build.",
                event_ids: [eventId, "e_skeptic_0000002"],
              },
              {
                kind: "silence",
                text: "No event shows the Sep 24 release actually going out.",
                event_ids: [],
              },
            ],
          }),
        };
      },
    };
    setLlmClientForTests(client);

    const result = await runSkeptic(investigationId);

    expect(result).toEqual({ flagged: 1, issues: 2 });
    expect(seenUserPrompt).toContain("Available but NEVER searched: jira, slack");
    expect(seenUserPrompt).toContain("already searched");

    const claims = await getClaims(investigationId);
    expect(claims.filter((claim) => claim.skepticFlag)).toHaveLength(1);
    expect(claims[0].skepticFlag).toBe(true);

    const notes = await getSkepticNotes(investigationId);
    expect(notes).toHaveLength(2);
    expect(notes.map((note) => note.kind)).toEqual(["contradiction", "silence"]);
    expect(notes[0].claimId).toBe(claims[0].id);

    const gaps = await getGaps(investigationId);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].note).toMatch(/Sep 24 release/);

    const stages = await getStages(investigationId);
    expect(stages.find((stage) => stage.stage === "skeptic")?.log).toHaveLength(1);
  });

  it("does not duplicate notes and gaps when the skeptic re-runs", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runSkeptic } = await import("../lib/agents/skeptic");
    const { getGaps, getSkepticNotes } = await import("../lib/store");

    setLlmClientForTests({
      chat: async () => ({
        content: JSON.stringify({
          issues: [
            {
              kind: "silence",
              text: "No record shows the Sep 24 release actually shipping.",
              event_ids: [],
            },
          ],
        }),
      }),
    });

    await runSkeptic(investigationId, 3);
    const notesAfterFirst = await getSkepticNotes(investigationId);
    const gapsAfterFirst = await getGaps(investigationId);

    await runSkeptic(investigationId, 4);
    expect(await getSkepticNotes(investigationId)).toHaveLength(notesAfterFirst.length);
    expect(await getGaps(investigationId)).toHaveLength(gapsAfterFirst.length);
  });

  it("degrades without throwing when the model call fails", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runSkeptic } = await import("../lib/agents/skeptic");
    const { getStages } = await import("../lib/store");

    setLlmClientForTests({
      chat: async () => {
        throw new Error("api down");
      },
    });

    const result = await runSkeptic(investigationId, 2);

    expect(result).toEqual({ flagged: 0, issues: 0 });
    const stages = await getStages(investigationId);
    const skepticStage = stages.find((stage) => stage.stage === "skeptic" && stage.pass === 2);
    expect(skepticStage?.log).toHaveLength(1);
  });

  /* I4: a single zero-finding pass is not a clean bill of health. */
  it("keeps deterministic detectors when the skeptic returns zero", async () => {
    const {
      createInvestigation,
      insertEvents,
      insertClaims,
      getClaims,
      getEvents,
      getSkepticNotes,
      getStages,
    } = await import("../lib/store");
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runSkeptic } = await import("../lib/agents/skeptic");
    const { buildReportModel } = await import("../lib/report/model");

    const id = await createInvestigation({
      title: `Premature ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(id);

    await insertEvents(id, [
      {
        id: "e_prem_status",
        source: "jira",
        ts: "2024-09-26T03:00:00.000Z",
        actor: "Marcus Webb",
        channel: "MER-101",
        text: "Status: In Progress → Resolved",
      },
      {
        id: "e_prem_qa",
        source: "slack",
        ts: "2024-09-26T10:00:00.000Z",
        actor: "Lin Chen",
        channel: "meridian-billing",
        text: "QA is still failing on the Sep 24 build.",
      },
    ]);
    await insertClaims(id, [
      {
        agent: "ownership",
        type: "process_failure",
        text: "The ticket was marked resolved.",
        quote: "Status: In Progress → Resolved",
        eventId: "e_prem_status",
        status: "n/a",
        confidence: 0.8,
      },
    ]);

    setLlmClientForTests({ chat: async () => ({ content: JSON.stringify({ issues: [] }) }) });
    const result = await runSkeptic(id);

    expect(result).toEqual({ flagged: 0, issues: 0 });
    expect(await getSkepticNotes(id)).toHaveLength(0);

    const stages = await getStages(id);
    const log = (stages.find((stage) => stage.stage === "skeptic")?.log[0] ?? {}) as {
      detectors?: number;
    };
    expect(log.detectors).toBeGreaterThan(0);

    // The report's audit path still surfaces the detector's contradiction.
    const model = buildReportModel({
      investigation: {
        title: "Premature resolution",
        escalationText: "",
        createdAt: "2024-09-01T00:00:00.000Z",
      },
      events: await getEvents(id),
      claims: await getClaims(id),
      commitments: [],
      gaps: [],
      notes: [],
      scope: null,
      clientDomains: [],
      clientActors: [],
    });
    expect(
      model.contradictions.some(
        (contradiction) => contradiction.detector === "premature_resolution",
      ),
    ).toBe(true);
  });

  it("runs one extra focused pass when the first pass returns nothing", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runSkeptic } = await import("../lib/agents/skeptic");
    const { getSkepticNotes } = await import("../lib/store");

    let calls = 0;
    const prompts: string[] = [];
    setLlmClientForTests({
      chat: async (messages) => {
        calls += 1;
        prompts.push(messages.map((message) => message.content ?? "").join("\n"));
        if (calls === 1) return { content: JSON.stringify({ issues: [] }) };
        return {
          content: JSON.stringify({
            issues: [
              { kind: "contradiction", text: "The focused pass found a conflict.", event_ids: [] },
            ],
          }),
        };
      },
    });

    const result = await runSkeptic(investigationId, 5);

    expect(calls).toBe(2);
    expect(result.issues).toBe(1);
    expect(prompts[1]).toMatch(/focused/i);
    expect(prompts[1]).toMatch(/top claims/i);
    const notes = await getSkepticNotes(investigationId);
    expect(notes.some((note) => note.text === "The focused pass found a conflict.")).toBe(true);
  });

  it("spends no second call when the first pass reports an issue and no detector fired", async () => {
    const { setLlmClientForTests } = await import("../lib/llm");
    const { runSkeptic } = await import("../lib/agents/skeptic");

    let calls = 0;
    setLlmClientForTests({
      chat: async () => {
        calls += 1;
        return {
          content: JSON.stringify({
            issues: [{ kind: "silence", text: "A gap the skeptic found.", event_ids: [] }],
          }),
        };
      },
    });

    await runSkeptic(investigationId, 6);
    expect(calls).toBe(1);
  });
});
