import { describe, expect, it } from "vitest";

import { rankEvents } from "../lib/agents/ranking";
import type { Event } from "../lib/types";

const event = (over: Partial<Event> & { id: string }): Event => ({
  investigationId: "inv",
  source: "slack",
  ts: "2024-09-10T03:00:00.000Z",
  actor: "Lin Chen",
  channel: "meridian-billing",
  text: "text",
  ...over,
});

describe("rankEvents", () => {
  it("ranks a cited ticket ref above a text mention above a weak channel hit", () => {
    const cited = event({ id: "cited", text: "Status update only.", refs: ["MER-201"] });
    const mentioned = event({ id: "mentioned", text: "We discussed MER-201 with QA." });
    const weak = event({ id: "weak", text: "Some other note.", channel: "mer-201-notes" });

    const ranked = rankEvents([weak, mentioned, cited], "MER-201");

    expect(ranked.map((entry) => entry.id)).toEqual(["cited", "mentioned", "weak"]);
  });

  it("ranks an exact phrase above scattered tokens", () => {
    const phrase = event({ id: "phrase", text: "The invoice fix shipped on Sep 24." });
    const tokens = event({ id: "tokens", text: "Invoice totals: we still need a fix later." });

    const ranked = rankEvents([tokens, phrase], "invoice fix");

    expect(ranked.map((entry) => entry.id)).toEqual(["phrase", "tokens"]);
  });

  it("adds the literal phrase bonus in mixed ref-plus-words queries", () => {
    const cited = event({ id: "cited", text: "Status update only.", refs: ["MER-101"], ts: "2024-09-25T00:00:00.000Z" });
    const onPoint = event({ id: "onPoint", text: "MER-101 invoice totals wrong since 4.12.", ts: "2024-09-01T00:00:00.000Z" });

    const ranked = rankEvents([cited, onPoint], "MER-101 invoice totals wrong");

    expect(ranked.map((entry) => entry.id)).toEqual(["onPoint", "cited"]);
  });

  it("breaks ties with the most recent record first", () => {
    const older = event({ id: "older", ts: "2024-09-01T00:00:00.000Z", text: "Invoice totals review." });
    const newer = event({ id: "newer", ts: "2024-09-20T00:00:00.000Z", text: "Invoice totals review." });

    const ranked = rankEvents([older, newer], "invoice");

    expect(ranked.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("leaves the order untouched for an empty query", () => {
    const a = event({ id: "a", ts: "2024-09-01T00:00:00.000Z" });
    const b = event({ id: "b", ts: "2024-09-02T00:00:00.000Z" });

    expect(rankEvents([a, b], "").map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(rankEvents([a, b], "   ").map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});
