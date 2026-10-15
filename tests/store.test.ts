import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../lib/db/env";

loadEnv();

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("event store", () => {
  const investigationTitle = `Test investigation ${randomUUID()}`;
  const contentHash = `hash-${randomUUID()}`;
  const ts1 = "2024-09-18T14:30:00.000Z";
  const ts2 = "2024-09-20T09:05:10.000Z";

  let investigationId: string;

  beforeAll(async () => {
    const { createInvestigation } = await import("../lib/store");
    investigationId = await createInvestigation({
      title: investigationTitle,
      escalationText: "Client says invoices are wrong.",
      contentHash,
    });
  });

  afterAll(async () => {
    const { getPool } = await import("../lib/db/pool");
    const sql = getPool();
    await sql`delete from investigations where id = ${investigationId}`;
    await sql.end();
  });

  it("createInvestigation returns a uuid and getInvestigation round-trips", async () => {
    const { getInvestigation } = await import("../lib/store");
    expect(investigationId).toMatch(/^[0-9a-f-]{36}$/);

    const inv = await getInvestigation(investigationId);
    expect(inv).not.toBeNull();
    expect(inv?.id).toBe(investigationId);
    expect(inv?.title).toBe(investigationTitle);
    expect(inv?.escalationText).toBe("Client says invoices are wrong.");
    expect(inv?.contentHash).toBe(contentHash);
    expect(inv?.plan).toBeNull();
    expect(typeof inv?.createdAt).toBe("string");
    expect(new Date(inv!.createdAt).toISOString()).toBe(inv!.createdAt);
  });

  it("findInvestigationByHash returns the same investigation", async () => {
    const { findInvestigationByHash } = await import("../lib/store");
    const inv = await findInvestigationByHash(contentHash);
    expect(inv?.id).toBe(investigationId);
  });

  it("getInvestigation returns null for an unknown id", async () => {
    const { getInvestigation } = await import("../lib/store");
    expect(await getInvestigation(randomUUID())).toBeNull();
  });

  it("setPlan persists the plan", async () => {
    const { setPlan, getInvestigation } = await import("../lib/store");
    await setPlan(investigationId, "Step 1: read the events.");
    expect((await getInvestigation(investigationId))?.plan).toBe("Step 1: read the events.");
  });

  it("insertEvents then getEvents round-trips events with UTC ISO timestamps", async () => {
    const { insertEvents, getEvents } = await import("../lib/store");
    await insertEvents(investigationId, [
      {
        id: "ev-1",
        source: "jira",
        ts: ts1,
        actor: "alice",
        channel: "SUP-2231",
        text: "Ticket opened",
        url: "https://jira.example/SUP-2231",
        refs: ["SUP-2231"],
      },
      {
        id: "ev-2",
        source: "slack",
        ts: ts2,
        actor: "bob",
        channel: "#support",
        text: "Any update?",
        threadId: "t-9",
        meta: { important: true },
      },
    ]);

    const events = await getEvents(investigationId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: "ev-1",
      investigationId,
      source: "jira",
      actor: "alice",
      channel: "SUP-2231",
      text: "Ticket opened",
      url: "https://jira.example/SUP-2231",
      ts: ts1,
      refs: ["SUP-2231"],
    });
    expect(events[1]).toMatchObject({
      id: "ev-2",
      source: "slack",
      actor: "bob",
      channel: "#support",
      text: "Any update?",
      ts: ts2,
      threadId: "t-9",
      meta: { important: true },
    });
    expect(events.map((event) => event.ts)).toEqual([ts1, ts2]);
  });

  it("getEvent returns a single event or null", async () => {
    const { getEvent } = await import("../lib/store");
    const event = await getEvent(investigationId, "ev-1");
    expect(event?.id).toBe("ev-1");
    expect(await getEvent(investigationId, "does-not-exist")).toBeNull();
  });

  it("insertEvents rejects a duplicate event id within an investigation", async () => {
    const { insertEvents } = await import("../lib/store");
    await expect(
      insertEvents(investigationId, [
        { id: "ev-1", source: "jira", ts: ts1, actor: "alice", channel: "SUP-2231", text: "duplicate" },
      ]),
    ).rejects.toThrow();
  });

  it("insertClaims then getClaims round-trips and verification/skeptic updates persist", async () => {
    const { insertClaims, getClaims, setClaimVerification, setClaimSkepticFlag } = await import("../lib/store");
    const inserted = await insertClaims(investigationId, [
      {
        agent: "root_cause",
        type: "commitment",
        text: "Fix promised for Sep 24.",
        actor: "alice",
        quote: "promised for Sep 24",
        eventId: "ev-1",
        ts: ts1,
        status: "unclear",
        confidence: 0.8,
      },
      {
        agent: "commitments",
        type: "observation",
        text: "No reply for four days.",
        quote: "Any update?",
        eventId: "ev-2",
        status: "n/a",
        confidence: 0.5,
      },
    ]);

    expect(inserted).toHaveLength(2);
    expect(inserted[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted[0].investigationId).toBe(investigationId);
    expect(inserted[0].verifyStatus).toBe("unverified");
    expect(inserted[0].skepticFlag).toBe(false);

    await setClaimVerification(inserted[0].id, "excluded", "quote not found");
    await setClaimSkepticFlag(inserted[1].id, true);

    const claims = await getClaims(investigationId);
    expect(claims).toHaveLength(2);
    const first = claims.find((claim) => claim.id === inserted[0].id);
    expect(first?.verifyStatus).toBe("excluded");
    expect(first?.verifyError).toBe("quote not found");
    const second = claims.find((claim) => claim.id === inserted[1].id);
    expect(second?.skepticFlag).toBe(true);
    expect(second?.confidence).toBe(0.5);
    expect(second?.status).toBe("n/a");
  });

  it("records skeptic notes and gaps without error", async () => {
    const { insertSkepticNotes, insertGaps } = await import("../lib/store");
    await insertSkepticNotes(investigationId, [
      { kind: "silence", text: "13-day gap in Jira.", eventIds: ["ev-1"] },
      { kind: "contradiction", text: "Resolved contradicts Slack.", eventIds: ["ev-1", "ev-2"] },
    ]);
    await insertGaps(investigationId, [
      { question: "Who took over the ticket?", note: "No handoff was recorded.", eventIds: [] },
    ]);
  });

  it("upsertStage is idempotent and appendStageLog accumulates", async () => {
    const { upsertStage, appendStageLog, getStages } = await import("../lib/store");
    await upsertStage(investigationId, "ingest", 1, "running");
    await upsertStage(investigationId, "ingest", 1, "done");
    await appendStageLog(investigationId, "ingest", 1, { tool: "search_events", n: 3 });
    await appendStageLog(investigationId, "ingest", 1, { tool: "get_event" });

    const stages = await getStages(investigationId);
    const ingest = stages.find((stage) => stage.stage === "ingest" && stage.pass === 1);
    expect(ingest?.status).toBe("done");
    expect(ingest?.log).toHaveLength(2);
    expect(ingest?.startedAt).toBeTruthy();
    expect(ingest?.finishedAt).toBeTruthy();
  });

  it("upsertIdentity is keyed by alias", async () => {
    const { upsertIdentity, getIdentities } = await import("../lib/store");
    await upsertIdentity(investigationId, {
      alias: "a.smith@northwind.example",
      canonical: "Alice Smith",
      method: "email",
      confidence: 0.98,
      applied: true,
    });
    await upsertIdentity(investigationId, {
      alias: "a.smith@northwind.example",
      canonical: "Alice Smith",
      method: "email+llm",
      confidence: 0.99,
      applied: true,
    });

    const identities = await getIdentities(investigationId);
    const matches = identities.filter((identity) => identity.alias === "a.smith@northwind.example");
    expect(matches).toHaveLength(1);
    expect(matches[0].canonical).toBe("Alice Smith");
    expect(matches[0].method).toBe("email+llm");
    expect(matches[0].confidence).toBeCloseTo(0.99, 5);
  });
});
