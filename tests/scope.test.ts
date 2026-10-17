import { describe, expect, it } from "vitest";

import {
  deriveScopeUniverse,
  identifyScope,
  matchScope,
  splitEventsByScope,
} from "../lib/pipeline/scope";
import type { Event, InvestigationScope } from "../lib/types";
import type { LlmClient } from "../lib/llm";

const event = (over: Partial<Event> & { id: string }): Event => ({
  investigationId: "inv",
  source: "jira",
  ts: "2024-09-10T03:00:00.000Z",
  actor: "Lin Chen",
  channel: "MER-201",
  text: "text",
  ...over,
});

const scope: InvestigationScope = {
  client: "Northwind Logistics",
  project: "Meridian Billing",
  ticketPrefixes: ["MER"],
  channels: ["meridian-billing"],
  senderDomains: ["northwind.example"],
};

describe("deriveScopeUniverse", () => {
  it("collects jira prefixes, slack channels and email sender domains", () => {
    const events = [
      event({ id: "a", channel: "MER-201" }),
      event({ id: "b", channel: "KST-301" }),
      event({ id: "c", source: "slack", channel: "meridian-billing" }),
      event({ id: "d", source: "slack", channel: "kestrel-eng" }),
      event({ id: "e", source: "email", actor: "Dana Okafor <billing@northwind.example>", channel: "email" }),
      event({ id: "f", source: "email", actor: "Ravi Patel <support@acme.example>", channel: "email" }),
    ];
    expect(deriveScopeUniverse(events)).toEqual({
      ticketPrefixes: ["KST", "MER"],
      channels: ["kestrel-eng", "meridian-billing"],
      senderDomains: ["acme.example", "northwind.example"],
    });
  });
});

describe("matchScope", () => {
  it("keeps jira issues under scoped prefixes and drops other projects", () => {
    expect(matchScope(scope, event({ id: "a", channel: "MER-201" }))).toBe(true);
    expect(matchScope(scope, event({ id: "b", channel: "KST-301" }))).toBe(false);
  });

  it("keeps scoped slack channels and drops other channels", () => {
    expect(matchScope(scope, event({ id: "c", source: "slack", channel: "meridian-billing" }))).toBe(true);
    expect(matchScope(scope, event({ id: "d", source: "slack", channel: "kestrel-eng" }))).toBe(false);
  });

  it("keeps email by sender domain or a scoped ticket reference", () => {
    expect(
      matchScope(scope, event({ id: "e", source: "email", actor: "Dana Okafor <billing@northwind.example>" })),
    ).toBe(true);
    expect(
      matchScope(scope, event({ id: "f", source: "email", actor: "X <ravi@acme.example>", text: "links to MER-201" })),
    ).toBe(true);
    expect(
      matchScope(
        scope,
        event({ id: "g", source: "email", actor: "X <ravi@acme.example>", text: "Acme rate limits were raised" }),
      ),
    ).toBe(false);
  });

  it("keeps an email whose extracted ticket refs point at a scoped project", () => {
    expect(
      matchScope(
        scope,
        event({
          id: "h",
          source: "email",
          actor: "Dana Okafor <billing@forwarder.example>",
          text: "Our invoices have been wrong since 4.12.", // the subject carried the ticket ref
          refs: ["MER-201"],
        }),
      ),
    ).toBe(true);
  });

  it("matches everything when there is no scope", () => {
    expect(matchScope(null, event({ id: "a", channel: "KST-301" }))).toBe(true);
  });
});

describe("splitEventsByScope", () => {
  it("splits without reordering", () => {
    const events = [
      event({ id: "in-1", channel: "MER-201" }),
      event({ id: "out-1", channel: "KST-301" }),
      event({ id: "in-2", source: "slack", channel: "meridian-billing" }),
    ];
    const { inScope, outOfScope } = splitEventsByScope(events, scope);
    expect(inScope.map((e) => e.id)).toEqual(["in-1", "in-2"]);
    expect(outOfScope.map((e) => e.id)).toEqual(["out-1"]);
  });

  it("keeps email replies in the same thread as an in-scope email", () => {
    const noDomains: InvestigationScope = {
      client: null,
      project: null,
      ticketPrefixes: ["MER"],
      channels: [],
      senderDomains: [],
    };
    const events = [
      event({
        id: "root",
        source: "email",
        channel: "email",
        actor: "Dana Okafor <billing@northwind.example>",
        text: "Our invoices have been wrong since 4.12 (MER-201).",
        threadId: "t1",
      }),
      event({
        id: "reply",
        source: "email",
        channel: "email",
        actor: "Priya Nair <priya@northwind.example>",
        text: "We will ship the invoice fix in the Sep 24 release.",
        threadId: "t1",
      }),
      event({
        id: "foreign",
        source: "email",
        channel: "email",
        actor: "Ravi Patel <support@acme.example>",
        text: "Acme's rate limits were raised.",
        threadId: "t2",
      }),
    ];

    const { inScope, outOfScope } = splitEventsByScope(events, noDomains);

    expect(inScope.map((e) => e.id)).toEqual(["root", "reply"]);
    expect(outOfScope.map((e) => e.id)).toEqual(["foreign"]);
  });
});

function scriptedClient(payload: unknown, fail = false): LlmClient {
  return {
    chat: async () => {
      if (fail) throw new Error("api down");
      return { content: JSON.stringify(payload) };
    },
  };
}

const universeEvents = [
  event({ id: "a", channel: "MER-201" }),
  event({ id: "c", source: "slack", channel: "meridian-billing" }),
  event({ id: "e", source: "email", actor: "Dana Okafor <billing@northwind.example>", channel: "email" }),
];

describe("identifyScope", () => {
  it("proposes a scope and drops values that do not exist in the store", async () => {
    const client = scriptedClient({
      client: "Northwind Logistics",
      project: "Meridian Billing",
      ticketPrefixes: ["MER", "XX"],
      channels: ["meridian-billing", "nope"],
      senderDomains: ["northwind.example", "ghost.example"],
    });
    await expect(
      identifyScope("Northwind Logistics reports wrong Meridian Billing invoices", universeEvents, client),
    ).resolves.toEqual({
      client: "Northwind Logistics",
      project: "Meridian Billing",
      ticketPrefixes: ["MER"],
      channels: ["meridian-billing"],
      senderDomains: ["northwind.example"],
    });
  });

  it("returns null when no concrete anchor survives verification", async () => {
    const client = scriptedClient({ client: "Ghost Corp", ticketPrefixes: ["ZZ"], channels: [], senderDomains: [] });
    await expect(identifyScope("something else entirely", universeEvents, client)).resolves.toBeNull();
  });

  it("degrades to null when the model call fails", async () => {
    await expect(identifyScope("escalation", universeEvents, scriptedClient({}, true))).resolves.toBeNull();
  });
});
