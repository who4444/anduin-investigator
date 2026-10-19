import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveScope, splitEventsByScope } from "../lib/pipeline/scope";
import type { LlmClient } from "../lib/llm";
import type { Event } from "../lib/types";

/* B1: scope selection is a deterministic graph over the records. The same
   events with two plausible model proposals must select the same scope, and
   the demo/realistic fixtures must keep their own project's records. */

interface FixtureFile {
  events: Event[];
  declaredClient: string | null;
}

function loadFixture(name: string): FixtureFile {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/decision", `${name}.json`), "utf8"));
  return { events: fixture.events as Event[], declaredClient: fixture.declaredClient ?? null };
}

function fakeLlm(reply: string): LlmClient {
  return {
    chat: async () => ({ content: reply }),
  } as unknown as LlmClient;
}

const PROPOSAL_MER = JSON.stringify({
  client: null,
  project: "Meridian Billing",
  ticketPrefixes: ["MER"],
  channels: ["meridian-billing"],
  senderDomains: [],
});
const PROPOSAL_NOTHING = JSON.stringify({
  client: null,
  project: null,
  ticketPrefixes: [],
  channels: [],
  senderDomains: [],
});

describe("deterministic scope graph (B1)", () => {
  it("two plausible model proposals select the same identifiers and records", async () => {
    const { events, declaredClient } = loadFixture("demo");
    const withProposal = await resolveScope("escalation", events, fakeLlm(PROPOSAL_MER), declaredClient);
    const withoutProposal = await resolveScope("escalation", events, fakeLlm(PROPOSAL_NOTHING), declaredClient);

    expect(withProposal).not.toBeNull();
    expect(withoutProposal).not.toBeNull();
    expect(withoutProposal!.ticketPrefixes.sort()).toEqual(withProposal!.ticketPrefixes.sort());
    expect(withoutProposal!.channels.sort()).toEqual(withProposal!.channels.sort());
    expect(withoutProposal!.senderDomains.sort()).toEqual(withProposal!.senderDomains.sort());

    const a = splitEventsByScope(events, withProposal);
    const b = splitEventsByScope(events, withoutProposal);
    expect(b.inScope.map((e) => e.id).sort()).toEqual(a.inScope.map((e) => e.id).sort());
  });

  it("the demo keeps its own project's records without model help", async () => {
    const { events, declaredClient } = loadFixture("demo");
    const scope = await resolveScope("escalation", events, fakeLlm(PROPOSAL_NOTHING), declaredClient);
    expect(scope).not.toBeNull();
    expect(scope!.ticketPrefixes).toContain("MER");
    expect(scope!.channels).toContain("meridian-billing");

    const { inScope } = splitEventsByScope(events, scope);
    const channels = new Set(inScope.map((e) => e.channel));
    expect(channels.has("MER-101")).toBe(true);
    expect(channels.has("meridian-billing")).toBe(true);
    // Status, assignee and comment records of the selected project are in scope.
    expect(inScope.some((e) => e.source === "jira" && /status/i.test(e.text) === false && e.channel === "MER-101")).toBe(true);
    expect(inScope.filter((e) => e.channel === "MER-101").length).toBeGreaterThan(2);
    // B1: the vendor's own release email (addressed from the vendor the client
    // escalates to) is in scope — the correspondence edge.
    expect(inScope.some((e) => /build is going out tonight/i.test(e.text))).toBe(true);
  });

  it("a shared vendor mailbox does not merge two tenants into one scoped run (C1)", async () => {
    const events: Event[] = [
      // Alpha tenant: the declared client.
      { id: "e-a1", investigationId: "inv", source: "email", ts: "2024-09-10T09:00:00.000Z", actor: "Ann Lee <ann@alpha.example>", channel: "email", text: "Our invoices are wrong since the upgrade. Please advise.", meta: { messageId: "m-a1", from: "ann@alpha.example", to: ["support@vendor.example"] } },
      // The vendor's replies to ALPHA.
      { id: "e-v1", investigationId: "inv", source: "email", ts: "2024-09-11T09:00:00.000Z", actor: "Vera Stone <vera@vendor.example>", channel: "email", text: "Looking into your invoice issue now.", meta: { messageId: "m-v1", from: "vera@vendor.example", to: ["ann@alpha.example"] } },
      // BETA tenant — same vendor mailbox, different client.
      { id: "e-b1", investigationId: "inv", source: "email", ts: "2024-09-10T10:00:00.000Z", actor: "Bob Poe <bob@beta.example>", channel: "email", text: "Beta's rate limits were raised today.", meta: { messageId: "m-b1", from: "bob@beta.example", to: ["support@vendor.example"] } },
      { id: "e-b2", investigationId: "inv", source: "email", ts: "2024-09-11T10:00:00.000Z", actor: "Vera Stone <vera@vendor.example>", channel: "email", text: "Beta: your rate-limit change is done.", meta: { messageId: "m-b2", from: "vera@vendor.example", to: ["bob@beta.example"] } },
      { id: "e-b3", investigationId: "inv", source: "jira", ts: "2024-09-12T09:00:00.000Z", actor: "Vera Stone", channel: "BETA-9", text: "Status: Open → In Progress" },
    ];
    const scope = await resolveScope(
      "From ann@alpha.example — our invoices are wrong since the upgrade.",
      events,
      fakeLlm(PROPOSAL_NOTHING),
      "Alpha Corp",
    );
    expect(scope).not.toBeNull();
    const { inScope } = splitEventsByScope(events, scope);
    const ids = inScope.map((e) => e.id);
    expect(ids).toContain("e-a1");
    expect(ids).toContain("e-v1");
    // The other tenant's records never join: not addressed to the client,
    // no shared thread, no shared selected prefix/channel.
    expect(ids).not.toContain("e-b1");
    expect(ids).not.toContain("e-b2");
    expect(ids).not.toContain("e-b3");
    expect(scope!.ticketPrefixes).not.toContain("BETA");
  });

  it("the realistic keeps LUM-804 and the qa/assignee records and never leaks tenants", async () => {
    const { events, declaredClient } = loadFixture("realistic");
    const scope = await resolveScope("escalation", events, fakeLlm(PROPOSAL_NOTHING), declaredClient);
    expect(scope).not.toBeNull();
    expect(scope!.ticketPrefixes).toContain("LUM");

    const { inScope, outOfScope } = splitEventsByScope(events, scope);
    expect(inScope.some((e) => e.channel === "LUM-804")).toBe(true);
    expect(inScope.some((e) => e.channel === "LUM-811")).toBe(true);
    // No distractor tenant record may leak in.
    const leaked = inScope.filter((e) => /\b(KST|VEG|RAV)-\d+\b/.test(e.channel) || /\b(KST|VEG|RAV)-\d+\b/.test(e.text));
    expect(leaked).toEqual([]);
    expect(outOfScope.length).toBeGreaterThan(0);
  });
});
