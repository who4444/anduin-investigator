import { describe, expect, it } from "vitest";

import { classifyNegative, negativeCompleteness } from "../lib/pipeline/negative";
import type { Event, Stage } from "../lib/types";

const event = (over: Partial<Event> & { id: string }): Event => ({
  investigationId: "inv",
  source: "slack",
  ts: "2024-09-20T09:00:00.000Z",
  actor: "Marcus Webb",
  channel: "meridian-billing",
  text: "text",
  ...over,
});

const stage = (toolCalls: unknown[]): Stage => ({
  stage: "root_cause",
  pass: 1,
  status: "done",
  log: [{ toolCalls }],
});

describe("classifyNegative (G-03)", () => {
  it("classifies the observed absence claims", () => {
    expect(classifyNegative("The client received no reply.")).toMatchObject({
      isNegative: true,
      subject: "reply",
    });
    expect(classifyNegative("Northwind's chases went unanswered.")).toMatchObject({
      isNegative: true,
      subject: "reply",
    });
    expect(classifyNegative("The engineer left with no handoff.")).toMatchObject({
      isNegative: true,
      subject: "handoff",
    });
    expect(classifyNegative("The promised fix never shipped.")).toMatchObject({
      isNegative: true,
      subject: "release",
    });
    expect(classifyNegative("The ticket was closed with no confirmation.")).toMatchObject({
      isNegative: true,
      subject: "confirmation",
    });
  });

  it("leaves ordinary findings alone", () => {
    expect(classifyNegative("The 4.12 timezone change introduced the defect.").isNegative).toBe(false);
    expect(classifyNegative("The fix shipped in the Sep 24 release.").isNegative).toBe(false);
    expect(classifyNegative("QA failed on the Sep 24 build.").isNegative).toBe(false);
    expect(classifyNegative("A handoff was documented in the changelog.").isNegative).toBe(false);
  });
});

describe("negativeCompleteness (G-03)", () => {
  const events: Event[] = [
    event({ id: "n1" }),
    event({ id: "n2", source: "email", channel: "email", actor: "Priya Nair <priya@northwind.example>", text: "Still waiting." }),
  ];

  it("is incomplete when an available source was never searched", () => {
    const proof = negativeCompleteness({
      events,
      stages: [stage([{ name: "search_slack", args: {}, resultCount: 1 }])],
      timeline: events,
      scope: null,
    });
    expect(proof.complete).toBe(false);
    expect(proof.notSearched).toEqual(["email"]);
    expect(proof.basis).toContain("email never searched");
  });

  it("is incomplete when a query failed", () => {
    const proof = negativeCompleteness({
      events,
      stages: [
        stage([
          { name: "search_slack", args: {}, resultCount: 1 },
          { name: "search_email", args: {}, resultCount: 1 },
          { name: "get_email_thread", args: { id: "x" } },
        ]),
      ],
      timeline: events,
      scope: null,
    });
    expect(proof.complete).toBe(false);
    expect(proof.failedQueries).toBe(1);
    expect(proof.basis).toContain("1 failed queries");
  });

  it("is complete when every available source was searched cleanly", () => {
    const proof = negativeCompleteness({
      events,
      stages: [
        stage([
          { name: "search_slack", args: {}, resultCount: 1 },
          { name: "search_email", args: {}, resultCount: 1 },
        ]),
      ],
      timeline: events,
      scope: null,
    });
    expect(proof.complete).toBe(true);
    expect(proof.basis).toContain("2/2 sources searched");
  });
});
