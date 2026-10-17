import { describe, expect, it } from "vitest";

import {
  deriveScopeUniverse,
  matchScope,
  resolveScope,
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
  confidence: "scoped",
  anchors: [],
};

const scopeEvents: Event[] = [
  event({ id: "e-mer-1", channel: "MER-201" }),
  event({ id: "e-mer-2", channel: "MER-202" }),
  event({
    id: "e-slack-mer",
    source: "slack",
    channel: "meridian-billing",
    text: "Sep 24 release is cut; invoice fix included. MER-202",
    refs: ["MER-202"],
  }),
  event({ id: "e-kst", channel: "KST-301", actor: "Ravi Patel", text: "Acme rate limits." }),
  event({
    id: "e-slack-kst",
    source: "slack",
    channel: "kestrel-eng",
    actor: "Ravi Patel",
    text: "Acme's Kestrel change is live.",
  }),
  event({
    id: "e-mail-nw",
    source: "email",
    channel: "email",
    actor: "Priya Nair <priya@northwind.example>",
    text: "Totals are still wrong after the promised fix.",
    refs: ["MER-201"],
  }),
  event({
    id: "e-mail-acme",
    source: "email",
    channel: "email",
    actor: "Ravi Patel <support@acme.example>",
    text: "Acme's limits were raised.",
  }),
];

describe("deriveScopeUniverse", () => {
  it("collects jira prefixes, slack channels and email sender domains", () => {
    expect(deriveScopeUniverse(scopeEvents)).toEqual({
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

  it("matches everything when the scope could not be confirmed", () => {
    const unconfirmed: InvestigationScope = { ...scope, confidence: "none" };
    expect(matchScope(unconfirmed, event({ id: "a", channel: "KST-301" }))).toBe(true);
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
      confidence: "partial",
      anchors: [],
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

function capturingClient(payload: unknown): { seen: string[]; client: LlmClient } {
  const seen: string[] = [];
  return {
    seen,
    client: {
      chat: async (messages) => {
        seen.push(messages.map((message) => message.content ?? "").join("\n"));
        return { content: JSON.stringify(payload) };
      },
    },
  };
}

const MER_CHANNEL_PROPOSAL = {
  client: "Northwind Logistics",
  project: "Meridian Billing",
  ticketPrefixes: ["MER"],
  channels: ["meridian-billing"],
  senderDomains: [],
};

describe("resolveScope", () => {
  it("reaches 'scoped' with more than two convergent anchors", async () => {
    const resolved = await resolveScope(
      "Northwind Logistics reports wrong Meridian Billing invoices (MER-201).",
      scopeEvents,
      scriptedClient(MER_CHANNEL_PROPOSAL),
      "Northwind Logistics",
    );

    expect(resolved).toMatchObject({
      client: "Northwind Logistics",
      project: "Meridian Billing",
      ticketPrefixes: ["MER"],
      channels: ["meridian-billing"],
      senderDomains: [],
      confidence: "scoped",
    });
    expect(resolved?.anchors.map((anchor) => anchor.source).sort()).toEqual([
      "declared",
      "escalation",
      "model",
    ]);
  });

  it("stays 'partial' with only two anchors", async () => {
    const resolved = await resolveScope(
      "Something about billing is broken.",
      scopeEvents,
      scriptedClient({ ...MER_CHANNEL_PROPOSAL, channels: [] }),
      null,
    );

    expect(resolved).toMatchObject({ confidence: "partial", ticketPrefixes: ["MER"] });
  });

  it("stays 'partial' on a single weak match instead of guessing", async () => {
    const resolved = await resolveScope(
      "Your billing module has been wrong since the last update.",
      scopeEvents,
      scriptedClient({ channels: ["meridian-billing"] }),
      null,
    );

    expect(resolved).toMatchObject({ confidence: "partial", channels: ["meridian-billing"] });
  });

  it("keeps the declared client but reports 'none' when no records match", async () => {
    const resolved = await resolveScope(
      "Escalation from a client we have no records for.",
      scopeEvents,
      scriptedClient({}),
      "Ghost Corp",
    );

    expect(resolved).toMatchObject({
      client: "Ghost Corp",
      project: null,
      ticketPrefixes: [],
      channels: [],
      confidence: "none",
    });
    expect(resolved?.anchors).toEqual([{ kind: "declared-client", value: "Ghost Corp", source: "declared" }]);
  });

  it("returns null when nothing at all is known", async () => {
    const resolved = await resolveScope("Something broke.", scopeEvents, scriptedClient({}), null);
    expect(resolved).toBeNull();
  });

  it("keeps the escalation-evidence component and downgrades on contradictions", async () => {
    const resolved = await resolveScope(
      "Northwind says MER-201 is still wrong.",
      scopeEvents,
      scriptedClient({ ticketPrefixes: ["MER", "KST"], channels: ["kestrel-eng"], senderDomains: [] }),
      null,
    );

    expect(resolved).toMatchObject({
      ticketPrefixes: ["MER"],
      channels: [],
      confidence: "partial",
    });
    expect(resolved?.channels).not.toContain("kestrel-eng");
  });

  it("passes the declared client to the model prompt", async () => {
    const capture = capturingClient(MER_CHANNEL_PROPOSAL);
    await resolveScope(
      "Northwind Logistics reports wrong invoices.",
      scopeEvents,
      capture.client,
      "Northwind Logistics",
    );
    expect(capture.seen[0]).toContain("Northwind Logistics");
  });

  it("derives anchors from the escalation text even when the model fails", async () => {
    const resolved = await resolveScope(
      "From: Priya Nair <priya@northwind.example> — MER-201 totals still wrong.",
      scopeEvents,
      scriptedClient({}, true),
      null,
    );

    expect(resolved).toMatchObject({
      confidence: "partial",
      ticketPrefixes: ["MER"],
      senderDomains: ["northwind.example"],
    });
    expect(resolved?.anchors.every((anchor) => anchor.source === "escalation")).toBe(true);
  });

  it("anchors on the sender of a stored email that matches the escalation text", async () => {
    const body =
      "As discussed on our call, our invoices have been wrong since release 4.12 and the promised Sep 24 fix did not arrive.";
    const events = [
      ...scopeEvents,
      event({
        id: "e-escalation-mail",
        source: "email",
        channel: "email",
        actor: "Dana Okafor <billing@northwind.example>",
        text: body,
      }),
    ];

    const resolved = await resolveScope(body, events, scriptedClient({}, true), null);

    expect(resolved).toMatchObject({ confidence: "partial" });
    expect(resolved?.senderDomains).toEqual(["northwind.example"]);
    expect(
      resolved?.anchors.some((anchor) => anchor.source === "escalation" && anchor.kind === "sender-domain"),
    ).toBe(true);
  });
});
