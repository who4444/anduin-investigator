import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("report versions (G-08)", () => {
  let investigationId: string;

  beforeAll(async () => {
    const { createInvestigation } = await import("../lib/store");
    investigationId = await createInvestigation({
      title: `Version ${randomUUID()}`,
      escalationText: "What happened?",
      contentHash: `version-${randomUUID()}`,
    });
  });

  afterAll(async () => {
    const { deleteInvestigation } = await import("../lib/store");
    await deleteInvestigation(investigationId);
  });

  it("freezes each assembled answer and returns the latest version", async () => {
    const { getLatestReportVersion, recordReportVersion } = await import("../lib/store");
    await recordReportVersion({
      investigationId,
      issueId: null,
      narrative: "First answer.",
      stats: { verified: 1 },
      model: "model-a",
      promptVersion: "v1",
    });
    await recordReportVersion({
      investigationId,
      issueId: null,
      narrative: "Second answer.",
      stats: { verified: 2 },
      model: "model-b",
      promptVersion: "v2",
    });

    const latest = await getLatestReportVersion(investigationId, null);
    expect(latest).toMatchObject({
      version: 2,
      narrative: "Second answer.",
      model: "model-b",
      promptVersion: "v2",
    });
  });
});
