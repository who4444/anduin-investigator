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
