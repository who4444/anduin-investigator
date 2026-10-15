import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("buildCoverage", () => {
  let investigationId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const { createInvestigation, insertEvents, appendStageLog } = await import("../lib/store");
    investigationId = await createInvestigation({
      title: `Coverage ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(investigationId);

    await insertEvents(investigationId, [
      {
        id: "e_coverage_jira_1",
        source: "jira",
        ts: "2024-09-10T03:00:00.000Z",
        actor: "Lin Chen",
        channel: "MER-101",
        text: "Timezone change merged for release 4.12.",
      },
      {
        id: "e_coverage_email_1",
        source: "email",
        ts: "2024-09-20T05:00:00.000Z",
        actor: "L. Chen <l.chen@northwind.example>",
        channel: "email",
        text: "We will ship the fix in the Sep 24 release.",
      },
      {
        id: "e_coverage_slack_1",
        source: "slack",
        ts: "2024-09-25T09:00:00.000Z",
        actor: "Dana Okoro",
        channel: "meridian-billing",
        text: "QA is still failing on the Sep 24 build.",
      },
    ]);

    // root_cause searched Jira and Slack; commitments searched email once; ownership searched nothing.
    await appendStageLog(investigationId, "root_cause", 1, {
      rounds: 2,
      toolCalls: [
        { name: "search_jira", args: { query: "timezone" } },
        { name: "get_issue", args: { key: "MER-101" } },
        { name: "search_slack", args: { channel: "meridian-billing" } },
      ],
    });
    await appendStageLog(investigationId, "commitments", 1, {
      toolCalls: [{ name: "search_email", args: { query: "Sep 24", sender: "" } }],
    });
    await appendStageLog(investigationId, "ownership", 1, { toolCalls: [] });
  });

  afterAll(async () => {
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) {
      await deleteInvestigation(id);
    }
  });

  it("reports availability, searched state and the queries that were run", async () => {
    const { getEvents, getStages } = await import("../lib/store");
    const { buildCoverage } = await import("../lib/pipeline/coverage");

    const report = buildCoverage(await getEvents(investigationId), await getStages(investigationId));

    const jira = report.sources.find((entry) => entry.source === "jira");
    expect(jira).toMatchObject({ available: 1, searched: true });
    expect(jira?.queries).toEqual([`search_jira("timezone")`, "get_issue(MER-101)"]);

    const email = report.sources.find((entry) => entry.source === "email");
    expect(email).toMatchObject({ available: 1, searched: true });
    expect(email?.queries).toEqual([`search_email("Sep 24")`]);

    const slack = report.sources.find((entry) => entry.source === "slack");
    expect(slack).toMatchObject({ available: 1, searched: true });
    expect(slack?.queries[0]).toContain("meridian-billing");

    expect(report.neverSearched).toEqual([]);
  });

  it("marks an available source that no investigator searched", async () => {
    const { createInvestigation, insertEvents, appendStageLog } = await import("../lib/store");
    const { buildCoverage } = await import("../lib/pipeline/coverage");

    const id = await createInvestigation({
      title: `Coverage2 ${randomUUID()}`,
      escalationText: "",
      contentHash: `hash-${randomUUID()}`,
    });
    created.push(id);

    await insertEvents(id, [
      {
        id: "e_coverage2_1",
        source: "slack",
        ts: "2024-09-25T09:00:00.000Z",
        actor: "Dana Okoro",
        channel: "general",
        text: "Unsearched noise.",
      },
    ]);
    await appendStageLog(id, "root_cause", 1, {
      toolCalls: [{ name: "get_issue", args: { key: "MER-101" } }],
    });

    const { getEvents, getStages } = await import("../lib/store");
    const report = buildCoverage(await getEvents(id), await getStages(id));

    expect(report.neverSearched).toEqual(["slack"]);
  });
});
