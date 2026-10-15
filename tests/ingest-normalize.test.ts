import { describe, expect, it } from "vitest";

import { capText, dedupeEvents, eventId, isoFromEpoch } from "../lib/ingest/normalize";
import type { EventInput } from "../lib/types";

describe("eventId", () => {
  const base = {
    source: "jira" as const,
    ts: "2024-09-18T14:30:00.000Z",
    actor: "alice",
    channel: "SUP-2231",
    text: "Ticket opened",
  };

  it("is stable for identical inputs and has the e_ + 16 hex shape", () => {
    const id = eventId(base.source, base.ts, base.actor, base.channel, base.text);
    expect(id).toMatch(/^e_[0-9a-f]{16}$/);
    expect(eventId(base.source, base.ts, base.actor, base.channel, base.text)).toBe(id);
  });

  it("changes when the text changes", () => {
    const a = eventId(base.source, base.ts, base.actor, base.channel, base.text);
    const b = eventId(base.source, base.ts, base.actor, base.channel, "Ticket reopened");
    expect(a).not.toBe(b);
  });
});

describe("isoFromEpoch", () => {
  it("converts a Slack epoch string preserving the fractional millisecond", () => {
    expect(isoFromEpoch("1727136000.000100")).toBe("2024-09-24T00:00:00.100Z");
  });

  it("converts a whole-number epoch to a UTC ISO string", () => {
    expect(isoFromEpoch(1727136000)).toBe("2024-09-24T00:00:00.000Z");
  });
});

describe("capText", () => {
  it("returns text unchanged when within the limit", () => {
    expect(capText("short")).toBe("short");
    expect(capText("x".repeat(4000))).toHaveLength(4000);
  });

  it("truncates long text at the limit and appends the marker", () => {
    const long = "a".repeat(4050);
    const out = capText(long);
    expect(out.endsWith("…[truncated]")).toBe(true);
    expect(out.slice(0, 4000)).toBe("a".repeat(4000));
  });

  it("honors a custom max", () => {
    expect(capText("abcdefghij", 4)).toBe("abcd…[truncated]");
  });
});

describe("dedupeEvents", () => {
  const first: EventInput = {
    source: "jira",
    ts: "2024-09-18T14:30:00.000Z",
    actor: "alice",
    channel: "SUP-2231",
    text: "Ticket opened",
  };

  it("collapses identical events to the first occurrence, preserving order", () => {
    const events: EventInput[] = [
      first,
      { source: "slack", ts: "2024-09-20T09:05:10.000Z", actor: "bob", channel: "#support", text: "Any update?" },
      { ...first },
    ];
    const out = dedupeEvents(events);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(first);
    expect(out[1].text).toBe("Any update?");
  });

  it("keeps events that differ in any key field", () => {
    const events: EventInput[] = [first, { ...first, text: "Ticket reopened" }];
    expect(dedupeEvents(events)).toHaveLength(2);
  });
});
