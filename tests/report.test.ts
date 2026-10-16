import { describe, expect, it } from "vitest";

import { validateReplyPayload } from "../lib/agents/reply";
import {
  buildAudit,
  buildLedger,
  buildMetrics,
  buildReportView,
  buildSilences,
  buildTimeline,
  buildTrust,
} from "../lib/report/build";
import type { Claim, Event, SkepticNote } from "../lib/types";

const event = (over: Partial<Event> & { id: string; ts: string }): Event => ({
  investigationId: "inv",
  source: "jira",
  actor: "Lin Chen",
  channel: "MER-101",
  text: "text",
  ...over,
});

const claim = (over: Partial<Claim> & { id: string; eventId: string }): Claim => ({
  investigationId: "inv",
  agent: "root_cause",
  type: "root_cause",
  text: "A finding.",
  quote: "text",
  status: "n/a",
  confidence: 0.8,
  verifyStatus: "kept",
  skepticFlag: false,
  ...over,
});

const events: Event[] = [
  event({ id: "e1", ts: "2024-09-10T03:00:00.000Z", text: "Timezone change merged for release 4.12." }),
  event({
    id: "e2",
    ts: "2024-09-23T04:00:00.000Z",
    text: "Root cause looks like the MER-87 timezone change.",
    source: "jira",
  }),
  event({
    id: "e3",
    ts: "2024-09-24T16:00:00.000Z",
    source: "slack",
    actor: "Marcus Webb",
    channel: "meridian-billing",
    text: "Sep 24 release is cut; fix included.",
  }),
  event({
    id: "e4",
    ts: "2024-09-25T09:00:00.000Z",
    source: "slack",
    actor: "Dana Okoro",
    channel: "meridian-billing",
    text: "QA is still failing on the Sep 24 build.",
  }),
  event({
    id: "e5",
    ts: "2024-09-26T02:10:00.000Z",
    source: "jira",
    actor: "Marcus Webb",
    text: "Marking MER-101 resolved; the fix is in the Sep 24 build.",
  }),
  event({
    id: "e6",
    ts: "2024-09-27T03:05:00.000Z",
    source: "email",
    actor: "Priya Nair <priya.nair@northwind.example>",
    channel: "email",
    text: "Totals are still wrong this morning.",
  }),
  event({
    id: "e7",
    ts: "2024-09-30T03:05:00.000Z",
    source: "email",
    actor: "Priya Nair <priya.nair@northwind.example>",
    channel: "email",
    text: "Still nothing. Escalating this on our side today.",
  }),
];

const claims: Claim[] = [
  claim({
    id: "c1",
    eventId: "e1",
    text: "The 4.12 timezone change introduced the defect.",
    type: "root_cause",
    ts: "2024-09-10T03:00:00.000Z",
  }),
  claim({
    id: "c2",
    eventId: "e3",
    type: "commitment",
    actor: "Marcus Webb",
    text: "The fix will ship in the Sep 24 release.",
    status: "broken",
    ts: "2024-09-24T16:00:00.000Z",
  }),
  claim({
    id: "c3",
    eventId: "e4",
    type: "process_failure",
    text: "QA failed on the Sep 24 build after the fix was promised.",
    status: "n/a",
    ts: "2024-09-25T09:00:00.000Z",
  }),
  claim({
    id: "c4",
    eventId: "e5",
    type: "process_failure",
    text: "The issue was marked resolved while other evidence disagreed.",
    status: "n/a",
    skepticFlag: true,
    ts: "2024-09-26T02:10:00.000Z",
  }),
  claim({
    id: "c5",
    eventId: "e6",
    type: "process_failure",
    text: "The client chased with no reply.",
    status: "n/a",
    ts: "2024-09-27T03:05:00.000Z",
  }),
  claim({
    id: "c6",
    eventId: "e2",
    text: "This claim should never appear anywhere.",
    verifyStatus: "excluded",
    verifyError: "quote_not_found",
    ts: "2024-09-23T04:00:00.000Z",
  }),
];

const notes: SkepticNote[] = [
  {
    id: "n1",
    investigationId: "inv",
    kind: "contradiction",
    text: "Resolved was set while QA failed the same build.",
    eventIds: ["e5", "e4"],
  },
];

describe("report metrics", () => {
  it("computes window, first response, commitments, silence and chasers", () => {
    const metrics = buildMetrics({ events, claims, notes });
    const byId = new Map(metrics.map((metric) => [metric.id, metric]));

    expect(byId.get("window")).toMatchObject({ determined: true, value: "17 days" });
    expect(byId.get("firstResponse")).toMatchObject({ determined: true });
    expect(byId.get("commitments")).toMatchObject({ value: "0 of 1" });
    expect(byId.get("longestSilence")).toMatchObject({ determined: true, value: "13 days" });
    expect(byId.get("chasers")).toMatchObject({ determined: false, value: "none found" });
    expect(byId.get("statusConflicts")?.claimIds).toEqual(["c4"]);
    expect(byId.get("processFailures")?.judgment).toBe(true);
  });

  it("reports not-determined instead of guessing on thin data", () => {
    const metrics = buildMetrics({
      events: [events[0]],
      claims: [claims[0]],
      notes: [],
    });
    const window = metrics.find((metric) => metric.id === "window");
    expect(window).toMatchObject({ determined: false, value: "not determined" });
  });
});

describe("report timeline", () => {
  it("groups verified findings by date and inserts a labelled silence", () => {
    const timeline = buildTimeline({ events, claims, notes });
    const dates = timeline.map((group) => group.date);
    expect(dates).toEqual([...dates].sort());

    const allRows = timeline.flatMap((group) => group.rows);
    const silence = allRows.find((row) => row.kind === "silence");
    expect(silence).toMatchObject({ days: 13 });
    expect(silence?.kind === "silence" && silence.label).toContain("13 days");

    const ids = allRows.filter((row) => row.kind === "claim").map((row) => (row.kind === "claim" ? row.claimId : ""));
    expect(ids).not.toContain("c6");
  });
});

describe("silences", () => {
  it("only reports gaps of three days or more", () => {
    const silences = buildSilences(events);
    expect(silences).toHaveLength(2);
    expect(silences.every((silence) => silence.days >= 3)).toBe(true);
  });
});

describe("ledger and audit", () => {
  it("extracts the stated deadline and marks days late", () => {
    const ledger = buildLedger({ events, claims, notes });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      claimId: "c2",
      outcome: "broken",
      deadline: "Sep 24",
      daysLate: 0,
    });
  });

  it("pairs a client-facing record with the internal record that disagreed", () => {
    const audit = buildAudit({
      events,
      claims,
      notes: [
        {
          id: "n2",
          investigationId: "inv",
          kind: "contradiction",
          text: "Client would have been told it was fixed.",
          eventIds: ["e6", "e5"],
        },
      ],
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].date).toBe("2024-09-27");
    expect(audit[0].toldEventId).toBe("e6");
    expect(audit[0].internalEventId).toBe("e5");
  });

  it("splits verified findings into safe-to-repeat and check-with-human", () => {
    const trust = buildTrust({ events, claims, notes });
    expect(trust.safeToRepeat.map((item) => item.claimId)).toEqual(["c1", "c2", "c3", "c5"]);
    expect(trust.checkWithHuman.map((item) => item.claimId)).toEqual(["c4"]);
    expect(trust.rejected).toHaveLength(1);
    expect(trust.rejected[0].reason).toBe("quote_not_found");
  });
});

describe("report view", () => {
  it("assembles every section", () => {
    const view = buildReportView({
      events,
      claims,
      notes: [
        ...notes,
        {
          id: "n2",
          investigationId: "inv",
          kind: "contradiction",
          text: "The client was told it was fixed while the record disagreed.",
          eventIds: ["e6", "e5"],
        },
      ],
    });
    expect(view.metrics.length).toBeGreaterThanOrEqual(8);
    expect(view.failures.length).toBeGreaterThan(0);
    expect(view.actions.immediate.length).toBeGreaterThan(0);
    expect(view.timeline.length).toBeGreaterThan(0);
    expect(view.ledger).toHaveLength(1);
    expect(view.audit).toHaveLength(1);
    expect(view.lanes.length).toBeGreaterThan(0);
    expect(view.causes.length).toBeGreaterThan(0);
  });
});

describe("reply validation", () => {
  const known = new Set(["c1", "c2"]);

  it("keeps only sentences that cite a verified finding", () => {
    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "One promise was broken.",
        sentences: [
          { text: "A timezone change in release 4.12 caused the totals error.", claimIds: ["c1"] },
          { text: "This sentence cites nothing.", claimIds: [] },
          { text: "This sentence cites a claim that does not exist.", claimIds: ["nope"] },
          { text: "The promised Sep 24 fix did not ship.", claimIds: ["c2", "ghost"] },
        ],
      }),
      known,
    );

    expect(result?.sentences.map((sentence) => sentence.text)).toEqual([
      "A timezone change in release 4.12 caused the totals error.",
      "The promised Sep 24 fix did not ship.",
    ]);
    expect(result?.sentences[1].claimIds).toEqual(["c2"]);
  });

  it("rejects a payload with no citable sentences", () => {
    expect(validateReplyPayload("not json", known)).toBeNull();
    expect(
      validateReplyPayload(JSON.stringify({ sentences: [{ text: "x", claimIds: [] }] }), known),
    ).toBeNull();
  });
});
