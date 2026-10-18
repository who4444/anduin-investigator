import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";
import type { SourceDefinition } from "../lib/sources/types";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const fakeJira = JSON.stringify({
  issues: [
    {
      key: "FAKE-1",
      self: "https://example.atlassian.net/rest/api/2/issue/FAKE-1",
      fields: {
        summary: `Pulled issue ${randomUUID()}`,
        created: "2024-09-10T00:00:00.000+0000",
        reporter: { displayName: "Lin Chen" },
      },
    },
  ],
});

let configured = true;

function fakeSource(): SourceDefinition {
  return {
    id: "jira",
    label: "Fake Jira",
    envKeys: ["FAKE_JIRA_TOKEN"],
    isConfigured: () => configured,
    missingEnv: () => (configured ? [] : ["FAKE_JIRA_TOKEN"]),
    listTargets: async () => [{ id: "FAKE", label: "FAKE · Fake project" }],
    pull: async () => ({ files: [{ name: "jira/fake.json", content: fakeJira }], warnings: ["fake warning"] }),
  };
}

describeDb("source routes", () => {
  const created: string[] = [];

  beforeAll(async () => {
    const { setSourcesForTests } = await import("../lib/sources");
    setSourcesForTests([fakeSource()]);
  });

  afterAll(async () => {
    const { setSourcesForTests } = await import("../lib/sources");
    setSourcesForTests(null);
    const { deleteInvestigation } = await import("../lib/store");
    for (const id of created) {
      await deleteInvestigation(id);
    }
  });

  it("lists sources with configuration state", async () => {
    const { GET } = await import("../app/api/sources/route");
    const response = await GET(new NextRequest("http://localhost/api/sources"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sources).toEqual([
      {
        id: "jira",
        label: "Fake Jira",
        envKeys: ["FAKE_JIRA_TOKEN"],
        configured: true,
        missingEnv: [],
      },
    ]);
  });

  it("lists targets for a configured source and explains unconfigured ones", async () => {
    const { GET } = await import("../app/api/sources/route");

    const configuredResponse = await GET(
      new NextRequest("http://localhost/api/sources?targets=jira"),
    );
    expect(configuredResponse.status).toBe(200);
    expect((await configuredResponse.json()).targets).toEqual([
      { id: "FAKE", label: "FAKE · Fake project" },
    ]);

    configured = false;
    const unconfiguredResponse = await GET(
      new NextRequest("http://localhost/api/sources?targets=jira"),
    );
    expect(unconfiguredResponse.status).toBe(409);
    expect((await unconfiguredResponse.json()).missingEnv).toEqual(["FAKE_JIRA_TOKEN"]);
    configured = true;
  });

  it("404s an unknown source", async () => {
    const { GET } = await import("../app/api/sources/route");
    const response = await GET(new NextRequest("http://localhost/api/sources?targets=nope"));
    expect(response.status).toBe(404);
  });

  it("rejects a pull from an unconfigured source", async () => {
    const { POST } = await import("../app/api/sources/pull/route");
    configured = false;
    const response = await POST(
      new NextRequest("http://localhost/api/sources/pull", {
        method: "POST",
        body: JSON.stringify({ source: "jira", targets: ["FAKE"] }),
      }),
    );
    expect(response.status).toBe(409);
    configured = true;
  });

  it("pulls, ingests and marks the stage done", async () => {
    const { POST } = await import("../app/api/sources/pull/route");
    const { getEvents, getInvestigation, getStages } = await import("../lib/store");

    const response = await POST(
      new NextRequest("http://localhost/api/sources/pull", {
        method: "POST",
        body: JSON.stringify({
          source: "jira",
          targets: ["FAKE"],
          query: "project = FAKE",
          escalation: "Client escalation from a live pull.",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.cached).toBe(false);
    expect(body.source).toBe("jira");
    expect(body.eventCount).toBeGreaterThanOrEqual(1);
    expect(body.warnings).toContain("fake warning");
    created.push(body.investigationId);

    const events = await getEvents(body.investigationId);
    expect(events.some((event) => event.source === "jira" && event.channel === "FAKE-1")).toBe(true);

    const investigation = await getInvestigation(body.investigationId);
    expect(investigation?.contentHash).toContain("jira:FAKE");

    const stages = await getStages(body.investigationId);
    expect(stages.find((stage) => stage.stage === "ingest")?.status).toBe("done");
  });

  it("400s when a pull returns no data", async () => {
    const { setSourcesForTests } = await import("../lib/sources");
    const emptySource: SourceDefinition = {
      ...fakeSource(),
      pull: async () => ({ files: [], warnings: ["nothing matched"] }),
    };
    setSourcesForTests([emptySource]);

    const { POST } = await import("../app/api/sources/pull/route");
    const response = await POST(
      new NextRequest("http://localhost/api/sources/pull", {
        method: "POST",
        body: JSON.stringify({ source: "jira", targets: ["FAKE"] }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("nothing matched");
    setSourcesForTests([fakeSource()]);
  });

  it("502s when the upstream API fails", async () => {
    const { setSourcesForTests } = await import("../lib/sources");
    const brokenSource: SourceDefinition = {
      ...fakeSource(),
      pull: async () => {
        throw new Error("Jira request failed (HTTP 401).");
      },
    };
    setSourcesForTests([brokenSource]);

    const { POST } = await import("../app/api/sources/pull/route");
    const response = await POST(
      new NextRequest("http://localhost/api/sources/pull", {
        method: "POST",
        body: JSON.stringify({ source: "jira", targets: ["FAKE"] }),
      }),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/HTTP 401/);
    setSourcesForTests([fakeSource()]);
  });
});
