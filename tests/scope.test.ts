import { describe, expect, it } from "vitest";

import {
  deriveScopeUniverse,
  excludedClientEvidence,
  matchScope,
  resolveScope,
  splitEventsByScope,
} from "../lib/pipeline/scope";
import type { Event, InvestigationScope } from "../lib/types";
import type { LlmClient } from "../lib/llm";
import { clientMailbox, clientMailboxScope, sharedChannel } from "./fixtures/p0";

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
      senderDomains: ["northwind.example"],
      confidence: "scoped",
    });
    expect(resolved?.anchors.map((anchor) => anchor.source).sort()).toEqual([
      "declared",
      "escalation",
      "linked",
    ]);
  });

  it("does not scope from a model proposal alone (B1: models never seed)", async () => {
    const resolved = await resolveScope(
      "Something about billing is broken.",
      scopeEvents,
      scriptedClient({ ...MER_CHANNEL_PROPOSAL, channels: [] }),
      null,
    );

    // The model's guess founds no anchors; without seeds the honest answer is
    // an unscoped run, not a partial scope built on one model proposal.
    expect(resolved).toBeNull();
  });

  it("does not scope from a single model channel guess", async () => {
    const resolved = await resolveScope(
      "Your billing module has been wrong since the last update.",
      scopeEvents,
      scriptedClient({ channels: ["meridian-billing"] }),
      null,
    );

    expect(resolved).toBeNull();
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

  it("links the declared client to its registry features deterministically", async () => {
    const events = [
      event({
        id: "e-nw-mail",
        source: "email",
        channel: "email",
        actor: "Dana Okoro <dana@northwind.example>",
        text: "Totals still wrong.",
      }),
    ];

    // The model proposes nothing — the declared client still links its domain.
    const resolved = await resolveScope(
      "Something is broken.",
      events,
      scriptedClient({}),
      "Northwind Logistics",
    );

    expect(resolved).toMatchObject({ confidence: "partial", senderDomains: ["northwind.example"] });
    expect(resolved?.anchors.some((anchor) => anchor.source === "linked")).toBe(true);
  });

  it("links the resolved project name to its ticket prefix, not just the model's guesses", async () => {
    const events = [
      event({
        id: "e-mer-status",
        channel: "MER-101",
        text: "Status: In Progress \u2192 Resolved",
      }),
      event({
        id: "e-sup-mail",
        source: "email",
        channel: "email",
        actor: "Priya Nair <priya@northwind.example>",
        text: "Separately, can you confirm the SUP-2231 renewal paperwork status?",
        refs: ["SUP-2231", "MER-101"],
      }),
    ];

    // The model proposes the decoy SUP prefix and misses MER; the resolved
    // project name "Meridian" must still link the MER- prefix deterministically.
    const resolved = await resolveScope(
      "As discussed on our call, Meridian carries a contractual SLA. Totals are still wrong.",
      events,
      scriptedClient({
        client: "Northwind Logistics",
        project: "Meridian",
        ticketPrefixes: ["SUP"],
        channels: [],
        senderDomains: [],
      }),
      "Northwind Logistics",
    );

    expect(resolved?.ticketPrefixes).toContain("MER");
    const { inScope } = splitEventsByScope(events, resolved);
    expect(inScope.map((entry) => entry.id)).toContain("e-mer-status");
  });

  it("does not link a declared token that only appears mid-feature-name", async () => {
    const events = [
      event({ id: "e-vertex", source: "slack", channel: "vertex-billing", text: "Vertex noise." }),
    ];

    const resolved = await resolveScope("Something is broken.", events, scriptedClient({}), "Billing Team");

    // vertex-billing must NOT match a declared "Billing Team", and with no
    // other evidence the scope stays none.
    expect(resolved).toMatchObject({ confidence: "none", channels: [] });
  });

  it("re-uses re-verified learned anchors even when the model proposes nothing", async () => {
    const learned: InvestigationScope = {
      client: "Bright Market",
      project: "Lumen Ledger",
      ticketPrefixes: ["LUM"],
      channels: ["lumen-general"],
      senderDomains: ["brightmarket.example"],
      confidence: "scoped",
      anchors: [],
    };

    // Realistic-workspace-like registry: LUM prefix and brightmarket domain
    // exist, so the learned identifiers re-verify; lumen-general bridges via
    // the promise message.
    const events = [
      event({ id: "e-lum", channel: "LUM-811", text: "VAT invoice exports blank." }),
      event({
        id: "e-bridge",
        source: "slack",
        channel: "lumen-general",
        text: "Bright Market escalation (LUM-811): fix scheduled.",
        refs: ["LUM-811"],
      }),
      event({
        id: "e-mail",
        source: "email",
        channel: "email",
        actor: "Dana Okafor <billing@brightmarket.example>",
        text: "Checking in.",
      }),
    ];

    const resolved = await resolveScope(
      "Something is broken again.",
      events,
      scriptedClient({}),
      "Bright Market",
      learned,
    );

    expect(resolved).toMatchObject({
      client: "Bright Market",
      project: "Lumen Ledger",
      ticketPrefixes: ["LUM"],
      channels: ["lumen-general"],
      // Disjoint record sets stay honestly partial — but the anchors SURVIVE
      // (filtering applies), which is what scope memory buys.
      confidence: "partial",
    });
    expect(resolved?.anchors.some((anchor) => anchor.source === "learned")).toBe(true);
  });

  it("drops learned identifiers that no longer exist in the registry", async () => {
    const learned: InvestigationScope = {
      client: "Bright Market",
      project: "Lumen Ledger",
      ticketPrefixes: ["LUM"],
      channels: ["lumen-general"],
      senderDomains: ["brightmarket.example"],
      confidence: "scoped",
      anchors: [],
    };
    // An empty registry universe: nothing re-verifies — the declared client
    // is kept with an honest none state, no filtering.
    const resolved = await resolveScope("broken.", [], scriptedClient({}), "Bright Market", learned);
    expect(resolved).toMatchObject({ client: "Bright Market", confidence: "none", ticketPrefixes: [] });
  });

  it("ignores a declared client that is not a real name", async () => {
    const resolved = await resolveScope(
      "Something about billing is broken.",
      scopeEvents,
      scriptedClient({ ticketPrefixes: ["MER"], channels: ["meridian-billing"] }),
      "&&&",
    );

    // Junk punctuation cannot be an anchor, and a model proposal cannot
    // replace it: nothing deterministic remains, so nothing scopes.
    expect(resolved).toBeNull();
  });

  it("returns null when nothing at all is known", async () => {
    const resolved = await resolveScope("Something broke.", scopeEvents, scriptedClient({}), null);
    expect(resolved).toBeNull();
  });

  it("expands escalation evidence deterministically and never pulls distractor tenants", async () => {
    const resolved = await resolveScope(
      "Northwind says MER-201 is still wrong.",
      scopeEvents,
      scriptedClient({ ticketPrefixes: ["MER", "KST"], channels: ["kestrel-eng"], senderDomains: [] }),
      null,
    );

    expect(resolved).toMatchObject({
      ticketPrefixes: ["MER"],
      confidence: "partial",
    });
    // The scoped project's channel comes with it (a record in it names MER);
    // the distractor tenant stays out even though the model proposed it.
    expect(resolved?.channels).toEqual(["meridian-billing"]);
    expect(resolved?.channels).not.toContain("kestrel-eng");
    expect(resolved?.ticketPrefixes).not.toContain("KST");
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

  it("refuses an email anchor when two boilerplate candidates are too close", async () => {
    const shared =
      "Hello, Thank you for reaching out to our support team. We reviewed your case thoroughly and confirm the status below as of today.";
    const mine = event({
      id: "e-mail-mine",
      source: "email",
      channel: "email",
      actor: "Priya Nair <support@northwind.example>",
      text: `${shared} The invoice totals are wrong since 4.12 and we are preparing the fix.`,
    });
    const other = event({
      id: "e-mail-other",
      source: "email",
      channel: "email",
      actor: "Ravi Patel <support@otherclient.example>",
      text: `${shared} The rate-limit increase is live and we are monitoring latency.`,
    });

    // The escalation is the client's own variant of the shared template.
    const escalation = `${shared} The invoice totals are wrong since 4.12 and we are preparing the fix.`;
    const resolved = await resolveScope(escalation, [mine, other], scriptedClient({}, true), null);

    // Without a clear margin the match is refused outright: no anchors, no scope.
    expect(resolved).toBeNull();
    expect(resolved === null || !resolved.senderDomains.includes("otherclient.example")).toBe(true);
  });

  it("never drops escalation-evidence anchors when components disagree", async () => {
    // No bridging record links the named ticket to the escalation sender —
    // they sit in separate components, and both are escalation evidence.
    const events = [
      event({ id: "e-mer", channel: "MER-201", text: "Invoice totals drift." }),
      event({
        id: "e-mail",
        source: "email",
        channel: "email",
        actor: "Dana Okafor <billing@northwind.example>",
        text: "Just checking in.",
      }),
      event({ id: "e-kst", channel: "KST-301", actor: "Ravi Patel", text: "Acme rate limits." }),
      event({
        id: "e-slack-kst",
        source: "slack",
        channel: "kestrel-eng",
        actor: "Ravi Patel",
        text: "Acme's Kestrel change is live.",
      }),
    ];

    const resolved = await resolveScope(
      "From dana@northwind.example — the invoice totals problem is MER-201.",
      events,
      scriptedClient({ channels: ["kestrel-eng"], ticketPrefixes: [], senderDomains: [] }),
      null,
    );

    expect(resolved).toMatchObject({ confidence: "partial" });
    expect(resolved?.ticketPrefixes).toContain("MER");
    expect(resolved?.senderDomains).toEqual(["northwind.example"]);
    expect(resolved?.channels).toEqual([]);
  });
});

/* G-01 ratchets. Scoping acts as a recall guard: client evidence wins over
   the exclusion rules; unrelated tenants stay excluded. These tests were the
   `it.fails` ratchets and flipped to green when the recall guard landed. */
describe("recall guard (G-01)", () => {
  const scoped: InvestigationScope = {
    client: "Northwind Logistics",
    project: "Meridian Billing",
    ticketPrefixes: ["MER"],
    channels: ["meridian-billing"],
    senderDomains: ["northwind.example"],
    confidence: "scoped",
    anchors: [],
  };

  it("keeps client messages in a shared channel outside the project scope", () => {
    const { inScope } = splitEventsByScope(sharedChannel.events, scoped);
    const ids = inScope.map((event) => event.id);
    expect(ids).toContain("f1-general-chase-1");
    expect(ids).toContain("f1-general-chase-2");
  });

  it("keeps the client mailbox when the scope has no domain anchor", () => {
    const { inScope } = splitEventsByScope(clientMailbox.events, clientMailboxScope);
    expect(inScope.map((event) => event.id)).toContain("f2-email");
  });

  it("still excludes records no client evidence touches", () => {
    const { outOfScope } = splitEventsByScope(sharedChannel.events, scoped);
    expect(outOfScope.map((event) => event.id)).toContain("f1-distractor");
  });
});

describe("excludedClientEvidence (G-01 invariant)", () => {
  /* While the recall guard holds, client evidence is kept in by
     construction, so the tripwire reads zero — it exists so a future
     filter (force-exclude, windows) cannot silently serve a draft over
     records that were dropped. */
  it("derives the client's domains from the declared name", () => {
    const result = excludedClientEvidence(clientMailbox.events, clientMailboxScope);
    expect(result.clientDomains).toEqual(["northwind.example"]);
    expect(result.excludedEventIds).toEqual([]);
  });

  it("flags nothing when the recall guard keeps client evidence in scope", () => {
    const result = excludedClientEvidence(sharedChannel.events, {
      client: "Northwind Logistics",
      project: "Meridian Billing",
      ticketPrefixes: ["MER"],
      channels: ["meridian-billing"],
      senderDomains: ["northwind.example"],
      confidence: "scoped",
      anchors: [],
    });
    expect(result.excludedEventIds).toEqual([]);
  });

  it("flags nothing without a scope", () => {
    expect(excludedClientEvidence(sharedChannel.events, null).excludedEventIds).toEqual([]);
  });
});

describe("force-include overrides (G-01 review)", () => {
  const scoped: InvestigationScope = {
    client: "Northwind Logistics",
    project: "Meridian Billing",
    ticketPrefixes: ["MER"],
    channels: ["meridian-billing"],
    senderDomains: ["northwind.example"],
    confidence: "scoped",
    anchors: [],
  };

  it("keeps a manager-added record the anchors alone would exclude", () => {
    const { inScope } = splitEventsByScope(sharedChannel.events, scoped, ["f1-distractor"]);
    expect(inScope.map((event) => event.id)).toContain("f1-distractor");
  });

  it("leaves the split unchanged without overrides", () => {
    const { outOfScope } = splitEventsByScope(sharedChannel.events, scoped, []);
    expect(outOfScope.map((event) => event.id)).toContain("f1-distractor");
  });
});

describe("G-01 client identity across tools", () => {
  const clientScope: InvestigationScope = {
    client: "Bright Market",
    project: "Lumen",
    ticketPrefixes: ["LUM"],
    channels: ["lumen-general"],
    senderDomains: ["brightmarket.example"],
    confidence: "scoped",
    anchors: [],
  };

  const events: Event[] = [
    event({
      id: "e-client-email",
      source: "email",
      channel: "email",
      actor: "Dana Okafor <billing@brightmarket.example>",
      text: "Still blank.",
    }),
    event({
      id: "e-client-slack",
      source: "slack",
      channel: "general",
      actor: "Dana Okafor",
      text: "Second chase on the VAT exports.",
    }),
    event({
      id: "e-internal-general",
      source: "slack",
      channel: "general",
      actor: "Marcus Hale",
      text: "Ticket triage done.",
    }),
    event({
      id: "e-distractor",
      source: "slack",
      channel: "vertex-billing",
      actor: "Ravi Patel",
      text: "Vertex billing roles.",
    }),
  ];

  it("links a Slack actor to the client by the email sender's display name", () => {
    const { inScope, outOfScope } = splitEventsByScope(events, clientScope);
    expect(inScope.map((item) => item.id)).toEqual([
      "e-client-email",
      "e-client-slack",
      "e-internal-general",
    ]);
    expect(outOfScope.map((item) => item.id)).toEqual(["e-distractor"]);
  });

  it("does not call a Slack client message excluded client evidence", () => {
    expect(excludedClientEvidence(events, clientScope).excludedEventIds).toEqual([]);
  });
});
