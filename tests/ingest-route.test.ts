import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const jiraExport = JSON.stringify({
  issues: [
    {
      key: "MER-101",
      self: "https://northwind.atlassian.net/rest/api/2/issue/MER-101",
      fields: {
        summary: `Timezone totals wrong ${randomUUID()}`,
        created: "2024-09-10T03:00:00.000+0000",
        reporter: { displayName: "Priya Nair" },
      },
      changelog: {
        histories: [
          {
            author: { displayName: "Lin Chen" },
            created: "2024-09-10T04:00:00.000+0000",
            items: [{ field: "status", fromString: "Open", toString: "In Progress" }],
          },
        ],
      },
    },
  ],
});

const mbox = [
  "From priya@northwind.example Tue Sep 24 09:30:00 2024",
  "From: Priya Nair <priya@northwind.example>",
  "Date: Tue, 24 Sep 2024 09:30:00 +0800",
  "Subject: Re SUP-2231 totals still wrong",
  "Message-ID: <route-test-1@northwind.example>",
  "",
  "Totals are still wrong after the 4.12 release.",
  "",
].join("\n");

function buildForm(): FormData {
  const form = new FormData();
  form.append("files", new File([jiraExport], "search.json", { type: "application/json" }));
  form.append("files", new File([mbox], "thread.mbox", { type: "application/mbox" }));
  form.append("escalation", "Client says totals are wrong since 4.12.");
  return form;
}

describeDb("POST /api/investigations", () => {
  let POST: (request: NextRequest) => Promise<Response>;
  let setLlmClientForTests: (client: { chat: () => Promise<{ content: string }> } | null) => void;
  const created: string[] = [];

  beforeAll(async () => {
    ({ POST } = await import("../app/api/investigations/route"));
    ({ setLlmClientForTests } = await import("../lib/llm"));
    setLlmClientForTests({ chat: async () => ({ content: '{"merges":[]}' }) });
  });

  afterAll(async () => {
    setLlmClientForTests(null);
    const { getPool } = await import("../lib/db/pool");
    const sql = getPool();
    for (const id of created) {
      await sql`delete from investigations where id = ${id}`;
    }
  });

  function request(form: FormData): NextRequest {
    return new NextRequest("http://localhost/api/investigations", { method: "POST", body: form });
  }

  it("creates an investigation, parses events, and marks the ingest stage done", async () => {
    const response = await POST(request(buildForm()));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.cached).toBe(false);
    expect(body.eventCount).toBeGreaterThanOrEqual(2);
    expect(body.investigationId).toMatch(/^[0-9a-f-]{36}$/);
    created.push(body.investigationId);

    const { getEvents, getStages } = await import("../lib/store");
    const events = await getEvents(body.investigationId);
    expect(events.some((event) => event.source === "jira")).toBe(true);
    const emailEvent = events.find((event) => event.source === "email");
    expect(emailEvent?.ts).toBe("2024-09-24T01:30:00.000Z");
    expect(emailEvent?.refs).toContain("SUP-2231");

    const stages = await getStages(body.investigationId);
    expect(stages).toEqual([
      expect.objectContaining({ stage: "ingest", status: "done" }),
    ]);
  });

  it("returns the cached investigation for identical uploads", async () => {
    const first = await POST(request(buildForm()));
    const firstBody = await first.json();
    created.push(firstBody.investigationId);

    const { upsertStage } = await import("../lib/store");
    await upsertStage(firstBody.investigationId, "assemble", 1, "done");

    const second = await POST(request(buildForm()));
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody).toEqual({
      investigationId: firstBody.investigationId,
      eventCount: 0,
      cached: true,
      warnings: [],
    });
  });

  it("does not serve a cached run when the escalation text differs", async () => {
    const first = await POST(request(buildForm()));
    const firstBody = await first.json();
    created.push(firstBody.investigationId);
    const { upsertStage } = await import("../lib/store");
    await upsertStage(firstBody.investigationId, "assemble", 1, "done");

    const secondForm = buildForm();
    secondForm.set("escalation", "A different client escalation entirely.");
    const second = await POST(request(secondForm));
    const secondBody = await second.json();
    created.push(secondBody.investigationId);

    expect(second.status).toBe(201);
    expect(secondBody.cached).toBe(false);
    expect(secondBody.investigationId).not.toBe(firstBody.investigationId);
  });

  it("persists the manager-declared client and treats it as part of the cache key", async () => {
    const firstForm = buildForm();
    firstForm.set("client", "Northwind Logistics");
    const first = await POST(request(firstForm));
    const firstBody = await first.json();
    created.push(firstBody.investigationId);

    const { getInvestigation, upsertStage } = await import("../lib/store");
    expect((await getInvestigation(firstBody.investigationId))?.declaredClient).toBe(
      "Northwind Logistics",
    );

    // Same files and escalation but a different declared client must not
    // reuse the cached run.
    await upsertStage(firstBody.investigationId, "assemble", 1, "done");
    const secondForm = buildForm();
    secondForm.set("client", "Another Client Corp");
    const second = await POST(request(secondForm));
    const secondBody = await second.json();
    created.push(secondBody.investigationId);

    expect(second.status).toBe(201);
    expect(secondBody.cached).toBe(false);
    expect(secondBody.investigationId).not.toBe(firstBody.investigationId);
  });

  it("persists the declared origin and the ingest warnings for later reporting", async () => {
    const form = buildForm();
    form.set("origin", "demo");
    // A file the parsers do not recognise produces a real warning.
    form.append("files", new File(["This is a readme."], "readme.txt", { type: "text/plain" }));

    const response = await POST(request(form));
    const body = await response.json();
    created.push(body.investigationId);
    expect(response.status).toBe(201);
    expect(body.warnings.some((warning: string) => warning.includes("readme.txt"))).toBe(true);

    const { getInvestigation } = await import("../lib/store");
    const stored = await getInvestigation(body.investigationId);
    expect(stored?.origin).toBe("demo");
    expect(stored?.ingestWarnings.some((warning) => warning.includes("readme.txt"))).toBe(true);
  });

  it.fails("does not serve a cached run produced by a different model version", async () => {
    const originalModel = process.env.DEEPSEEK_MODEL;
    try {
      process.env.DEEPSEEK_MODEL = "model-a";
      const first = await POST(request(buildForm()));
      const firstBody = await first.json();
      if (firstBody.investigationId) created.push(firstBody.investigationId);
      const { upsertStage } = await import("../lib/store");
      await upsertStage(firstBody.investigationId, "assemble", 1, "done");

      // Same files, same escalation, same declared client — but the run that
      // produced the cache entry used a different model. Serving it would
      // hand back findings this model never produced (G-08).
      process.env.DEEPSEEK_MODEL = "model-b";
      const second = await POST(request(buildForm()));
      expect(second.status).toBe(201);
    } finally {
      if (originalModel === undefined) delete process.env.DEEPSEEK_MODEL;
      else process.env.DEEPSEEK_MODEL = originalModel;
    }
  });

  it("rejects an upload with no files", async () => {
    const response = await POST(request(new FormData()));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/no files/i);
  });
});
