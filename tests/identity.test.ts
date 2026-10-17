import { describe, expect, it, vi } from "vitest";

import {
  applyAliases,
  applyLlmMerges,
  deterministicAliases,
  resolveIdentities,
  suggestLlmMerges,
} from "../lib/ingest/identity";
import type { LlmClient } from "../lib/llm";
import type { EventInput, IdentityResolutionInput } from "../lib/types";

const event = (actor: string, text = "message"): EventInput => ({
  source: "slack",
  ts: "2024-09-20T09:00:00.000Z",
  actor,
  channel: "meridian-billing",
  text,
});

function makeStore() {
  const rows: IdentityResolutionInput[] = [];
  return {
    rows,
    store: {
      upsertIdentity: vi.fn(async (row: IdentityResolutionInput) => {
        rows.push(row);
      }),
    },
  };
}

function clientReturning(payload: unknown): LlmClient {
  return {
    chat: vi.fn(async () => ({ content: JSON.stringify(payload) })),
  };
}

describe("deterministicAliases", () => {
  it("merges actor forms that share an email to the most frequent display name", () => {
    const events = [
      event("L. Chen <l.chen@northwind.com>"),
      event("l.chen@northwind.com"),
      event("Lin Chen <l.chen@northwind.com>"),
      event("Lin Chen <l.chen@northwind.com>", "second message"),
    ];

    const aliases = deterministicAliases(events);

    expect(aliases.get("L. Chen <l.chen@northwind.com>")).toBe("Lin Chen <l.chen@northwind.com>");
    expect(aliases.get("l.chen@northwind.com")).toBe("Lin Chen <l.chen@northwind.com>");
    expect(aliases.get("Lin Chen <l.chen@northwind.com>")).toBeUndefined();
  });

  it("merges exact name matches regardless of case", () => {
    const aliases = deterministicAliases([event("Priya Nair"), event("priya nair")]);

    expect(aliases.get("priya nair")).toBe("Priya Nair");
    expect(aliases.get("Priya Nair")).toBeUndefined();
  });

  it("leaves distinct people unmerged", () => {
    const aliases = deterministicAliases([event("Lin Chen"), event("Marcus Webb")]);

    expect(aliases.size).toBe(0);
  });

  it("keeps the address in the canonical actor even when the name form is more frequent", () => {
    const aliases = deterministicAliases([
      event("Priya Nair"),
      event("Priya Nair <priya.nair@northwind.example>"),
      event("Priya Nair <priya.nair@northwind.example>", "second message"),
    ]);

    expect(aliases.get("Priya Nair <priya.nair@northwind.example>")).toBeUndefined();
    expect(aliases.get("Priya Nair")).toBeUndefined();
  });
  it("does not collapse two different people who share a display name", () => {
    const events = [
      event("Alex Kim <alex.kim@northwind.example>", "vendor message"),
      event("Alex Kim <alex.kim@meridian.example>", "client message"),
    ];

    const aliases = deterministicAliases(events);

    expect(aliases.get("Alex Kim <alex.kim@northwind.example>")).toBeUndefined();
    expect(aliases.get("Alex Kim <alex.kim@meridian.example>")).toBeUndefined();
  });

  it("still merges name variants when the shared name is not ambiguous", () => {
    const events = [
      event("L. Chen <l.chen@northwind.com>"),
      event("Lin Chen <l.chen@northwind.com>", "second message"),
      event("Lin Chen <l.chen@northwind.com>", "third message"),
    ];

    const aliases = deterministicAliases(events);

    expect(aliases.get("L. Chen <l.chen@northwind.com>")).toBe("Lin Chen <l.chen@northwind.com>");
    expect(aliases.get("Lin Chen <l.chen@northwind.com>")).toBeUndefined();
  });
});

describe("suggestLlmMerges", () => {
  it("returns validated merge suggestions from the model", async () => {
    const client = clientReturning({
      merges: [{ alias: "L. Chen", canonical: "Lin Chen", confidence: 0.95 }],
    });

    const suggestions = await suggestLlmMerges([event("L. Chen"), event("Lin Chen")], client);

    expect(suggestions).toEqual([{ alias: "L. Chen", canonical: "Lin Chen", confidence: 0.95 }]);
    expect(client.chat).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when the model output is not usable JSON", async () => {
    const client: LlmClient = { chat: vi.fn(async () => ({ content: "sorry, no idea" })) };

    await expect(suggestLlmMerges([event("L. Chen")], client)).resolves.toEqual([]);
  });
});

describe("applyAliases", () => {
  it("rewrites actors and records deterministic resolutions", async () => {
    const events = [event("l.chen@northwind.com"), event("Marcus Webb")];
    const aliases = new Map([["l.chen@northwind.com", "Lin Chen"]]);
    const { store } = makeStore();

    const out = await applyAliases(events, aliases, store);

    expect(out.map((e) => e.actor)).toEqual(["Lin Chen", "Marcus Webb"]);
    expect(store.upsertIdentity).toHaveBeenCalledWith({
      alias: "l.chen@northwind.com",
      canonical: "Lin Chen",
      method: "exact_email",
      confidence: 1,
      applied: true,
    });
  });

  it("does not mutate the input events", async () => {
    const events = [event("l.chen@northwind.com")];
    const { store } = makeStore();

    await applyAliases(events, new Map([["l.chen@northwind.com", "Lin Chen"]]), store);

    expect(events[0].actor).toBe("l.chen@northwind.com");
  });
});

describe("applyLlmMerges", () => {
  it("applies high-confidence suggestions that share an email or a name token", async () => {
    const events = [event("L. Chen"), event("Lin Chen")];
    const { store } = makeStore();

    const out = await applyLlmMerges(
      events,
      [{ alias: "L. Chen", canonical: "Lin Chen", confidence: 0.95 }],
      store,
    );

    expect(out.map((e) => e.actor)).toEqual(["Lin Chen", "Lin Chen"]);
    expect(store.upsertIdentity).toHaveBeenCalledWith({
      alias: "L. Chen",
      canonical: "Lin Chen",
      method: "llm",
      confidence: 0.95,
      applied: true,
    });
  });

  it("cannot strip an email address when merging an alias to a bare name", async () => {
    const events = [event("Dana Okoro <dana@northwind.example>"), event("Dana Okoro")];
    const { store } = makeStore();

    const out = await applyLlmMerges(
      events,
      [{ alias: "Dana Okoro <dana@northwind.example>", canonical: "Dana Okoro", confidence: 0.95 }],
      store,
    );

    // The model picked the display name; the code keeps the address, because
    // cross-source linking and domain-based scoping depend on it. The bare
    // alias is a different actor and stays untouched in this pass.
    expect(out.map((e) => e.actor)).toEqual([
      "Dana Okoro <dana@northwind.example>",
      "Dana Okoro",
    ]);
    expect(store.upsertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        alias: "Dana Okoro <dana@northwind.example>",
        canonical: "Dana Okoro <dana@northwind.example>",
        applied: true,
      }),
    );
  });

  it("does not apply low-confidence suggestions but records them", async () => {
    const events = [event("L. Chen")];
    const { store } = makeStore();

    const out = await applyLlmMerges(
      events,
      [{ alias: "L. Chen", canonical: "Lin Chen", confidence: 0.6 }],
      store,
    );

    expect(out[0].actor).toBe("L. Chen");
    expect(store.upsertIdentity).toHaveBeenCalledWith({
      alias: "L. Chen",
      canonical: "Lin Chen",
      method: "llm",
      confidence: 0.6,
      applied: false,
    });
  });

  it("does not apply suggestions with no email or name-token overlap", async () => {
    const events = [event("Bob Smith")];
    const { store } = makeStore();

    const out = await applyLlmMerges(
      events,
      [{ alias: "Bob Smith", canonical: "Alice Jones", confidence: 0.99 }],
      store,
    );

    expect(out[0].actor).toBe("Bob Smith");
    expect(store.upsertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "Bob Smith", canonical: "Alice Jones", applied: false }),
    );
  });
});

describe("resolveIdentities", () => {
  it("combines deterministic merges with LLM suggestions through a chain", async () => {
    const events = [
      event("l.chen@northwind.com"),
      event("L. Chen"),
      event("Lin Chen"),
    ];
    const { store } = makeStore();
    const client = clientReturning({
      merges: [
        { alias: "l.chen@northwind.com", canonical: "Lin Chen <l.chen@northwind.com>", confidence: 0.95 },
        { alias: "L. Chen", canonical: "Lin Chen", confidence: 0.95 },
        { alias: "Lin Chen", canonical: "Lin Chen <l.chen@northwind.com>", confidence: 0.95 },
      ],
    });

    const out = await resolveIdentities(events, client, store);

    // The address-bearing canonical is the identity every form resolves to,
    // and the chain L. Chen -> Lin Chen -> Lin Chen <addr> resolves in one pass.
    expect(out.map((e) => e.actor)).toEqual([
      "Lin Chen <l.chen@northwind.com>",
      "Lin Chen <l.chen@northwind.com>",
      "Lin Chen <l.chen@northwind.com>",
    ]);
  });

  it("degrades gracefully when the LLM call fails", async () => {
    const events = [
      event("l.chen@northwind.com"),
      event("Lin Chen <l.chen@northwind.com>"),
      event("Marcus Webb"),
    ];
    const { store } = makeStore();
    const client: LlmClient = {
      chat: vi.fn(async () => {
        throw new Error("api down");
      }),
    };

    const out = await resolveIdentities(events, client, store);

    expect(out.map((e) => e.actor)).toEqual(["Lin Chen <l.chen@northwind.com>", "Lin Chen <l.chen@northwind.com>", "Marcus Webb"]);
    expect(store.upsertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "l.chen@northwind.com", canonical: "Lin Chen <l.chen@northwind.com>" }),
    );
  });
});
