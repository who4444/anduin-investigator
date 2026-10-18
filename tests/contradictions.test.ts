import { describe, expect, it } from "vitest";

import { detectContradictions } from "../lib/report/contradictions";
import type { Commitment, Event } from "../lib/types";

const event = (over: Partial<Event> & { id: string; ts: string; text: string }): Event => ({
  investigationId: "inv",
  source: "jira",
  actor: "Ravi Menon",
  channel: "LUM-811",
  ...over,
});


describe("deterministic contradiction detectors (C3)", () => {
  it("flags a premature resolution when QA re-runs red the same build", () => {
    const events = [
      event({ id: "e-res", ts: "2024-09-21T10:00:00.000Z", actor: "Priya Raman", text: "Status: In Progress → Resolved" }),
      event({
        id: "e-qa",
        ts: "2024-09-21T16:00:00.000Z",
        actor: "Sam Rivera",
        text: "Re-ran finance sandbox: VAT exports are still blank. QA failing on the same build; 5.3.3 did not fix it; reopened.",
      }),
    ];
    const contradictions = detectContradictions({ events, claims: [], promises: [], asOf: "2024-09-30" });
    expect(contradictions.map((c) => c.detector)).toContain("premature_resolution");
    const premature = contradictions.find((c) => c.detector === "premature_resolution")!;
    expect(premature.basis).toContain("e-res");
    expect(premature.managerText.length).toBeGreaterThan(0);
  });

  it("flags a missed promise when the deadline passes without delivery evidence", () => {
    const events = [
      event({ id: "e-promise", ts: "2024-09-10T10:00:00.000Z", text: "We will ship the export fix in the Sep 24 release." }),
    ];
    const promise: Commitment = {
      id: "p1",
      investigationId: "inv",
      claimId: "cm-claim",
      issueId: null,
      promisor: "Lin Chen",
      promisee: "Northwind",
      object: "invoice totals corrected",
      conditions: null,
      deadlinePhrase: "Sep 24",
      deadlineIso: "2024-09-24T00:00:00.000Z",
      rationale: null,
      status: "broken",
      contested: false,
      fulfilmentEventIds: [],
      sourceEventIds: ["e-promise"],
      dedupeKey: "k",
      createdAt: "2024-09-20T00:00:00.000Z",
    };
    const contradictions = detectContradictions({
      events,
      claims: [],
      promises: [promise],
      asOf: "2024-09-30",
    });
    expect(contradictions.map((c) => c.id)).toContain(`missed_promise:${promise.id}`);
  });

  it("cites an unanswered client message after the last vendor reply", () => {
    const events = [
      event({ id: "e-reply", ts: "2024-09-14T10:00:00.000Z", text: "Reply from vendor." }),
      event({ id: "e-chase", ts: "2024-09-24T10:00:00.000Z", actor: "Priya Nair <priya.nair@northwind.example>", source: "email", channel: "email", text: "Still nothing. Escalating this on our side today." }),
    ];
    const contradictions = detectContradictions({
      events,
      claims: [],
      promises: [],
      asOf: "2024-09-30",
      clientEvidence: { domains: ["northwind.example"], actors: ["priya nair"], channels: [], threads: [], eventIds: [] },
    });
    expect(contradictions.map((c) => c.detector)).toContain("unanswered_client");
  });

  it("returns nothing when the records agree", () => {
    const contradictions = detectContradictions({ events: [], claims: [], promises: [], asOf: "" });
    expect(contradictions).toEqual([]);
  });
});
