import { describe, expect, it } from "vitest";

import { validateReplyPayload, pruneStaleReply } from "../lib/agents/reply";
import {
  buildAudit,
  buildLanes,
  buildLedger,
  buildMetrics,
  buildReportView,
  buildSilences,
  buildTimeline,
  buildTrust,
} from "../lib/report/build";
import type { Claim, Commitment, Event, SkepticNote } from "../lib/types";
import { duplicatePromise } from "./fixtures/p0";

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
  verifyStatus: "verified",
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
    verifyStatus: "rejected",
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
    const metrics = buildMetrics({ events, claims, notes, clientActors: ["priya nair"] });
    const byId = new Map(metrics.map((metric) => [metric.id, metric]));

    expect(byId.get("window")).toMatchObject({ determined: true, value: "17 days" });
    expect(byId.get("firstResponse")).toMatchObject({ determined: true });
    expect(byId.get("commitments")).toMatchObject({ value: "1 of 1 broken" });
    // Cited records only: uncited registry noise no longer shortens the gap.
    expect(byId.get("longestSilence")).toMatchObject({ determined: true, value: "15 days" });
    // B5: only client evidence counts chases — the engineer's e1→e2 run is
    // never a chase, the client's e6→e7 run is.
    expect(byId.get("chasers")).toMatchObject({ determined: true, value: "2 from Priya Nair", eventIds: ["e6", "e7"] });
    expect(byId.get("statusConflicts")?.claimIds).toEqual(["c4"]);
    expect(byId.get("processFailures")?.judgment).toBe(true);
  });

  it("counts only client actors as unanswered chasers", () => {
    const clientEvents = [
      event({ id: "x1", ts: "2024-09-22T09:00:00.000Z", actor: "Dana Okafor", source: "slack", channel: "general", text: "First chase." }),
      event({ id: "x2", ts: "2024-09-23T09:00:00.000Z", actor: "Dana Okafor", source: "slack", channel: "general", text: "Second chase." }),
      event({ id: "x3", ts: "2024-09-23T10:00:00.000Z", actor: "Ravi Menon", source: "slack", channel: "orbit-support", text: "Looking." }),
      event({ id: "x4", ts: "2024-09-24T09:00:00.000Z", actor: "Ravi Menon", source: "slack", channel: "orbit-support", text: "Still looking." }),
    ];
    const chasers = buildMetrics({
      events: clientEvents,
      claims: [],
      notes: [],
      clientActors: ["Dana Okafor"],
    }).find((metric) => metric.id === "chasers");
    expect(chasers?.determined).toBe(true);
    expect(chasers?.value).toContain("2 from Dana Okafor");
    expect(chasers?.eventIds).toEqual(["x1", "x2"]);
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

  it("phrases broken-promise actions by claim length", () => {
    const longBroken = claim({
      id: "cb",
      eventId: "e3",
      type: "commitment",
      status: "broken",
      text: "The invoice fix was included in the Sep 24 release build and the client was told it was resolved while QA was still failing that exact build.",
      ts: "2024-09-24T16:00:00.000Z",
    });
    const shortBroken = claim({
      id: "cs",
      eventId: "e3",
      type: "commitment",
      status: "broken",
      text: "The fix ships Sep 24.",
      ts: "2024-09-24T16:05:00.000Z",
    });
    const { actions } = buildReportView({ events, claims: [longBroken, shortBroken], notes: [] });
    const long = actions.immediate.find((action) => action.claimIds.includes("cb"));
    const short = actions.immediate.find((action) => action.claimIds.includes("cs"));

    expect(long?.text).toMatch(/^Close out the broken promise — “The invoice fix was included in the Sep 24 release build and the client was told…”. Set a dated plan/);
    expect(short?.text).toMatch(/^Re-commit to The fix ships Sep 24\. with a dated plan/);
  });

  it("finds leave and handoff findings even when they are not typed process_failure", () => {
    const ownershipClaim = claim({
      id: "leave1",
      eventId: "e4",
      type: "ownership",
      text: "The owner went on leave with no handoff and the rota still lists her.",
      ts: "2024-09-25T09:00:00.000Z",
    });
    const metrics = buildMetrics({ events, claims: [...claims, ownershipClaim], notes: [] });
    const handoffs = metrics.find((metric) => metric.id === "handoffs");
    expect(handoffs).toMatchObject({ determined: true, value: "1" });
    expect(handoffs?.claimIds).toEqual(["leave1"]);
  });

  it("detects an unanswered chaser run even when the later message was never cited", () => {
    const metrics = buildMetrics({
      events: [events[5], events[6]],
      claims: [claims[4]],
      notes: [],
      clientActors: ["priya nair"],
    });
    const chasers = metrics.find((metric) => metric.id === "chasers");
    expect(chasers?.determined).toBe(true);
    expect(chasers?.value).toContain("2 from Priya");
    expect(chasers?.eventIds).toEqual(["e6", "e7"]);
  });

  it("does not report a chaser run when an uncited reply sits between the messages", () => {
    const reply = event({
      id: "e6b",
      ts: "2024-09-28T09:00:00.000Z",
      source: "slack",
      actor: "Dana Okoro",
      channel: "meridian-billing",
      text: "Sorry for the silence — we are looking into it.",
    });
    const metrics = buildMetrics({
      events: [events[5], reply, events[6]],
      claims: [
        claims[4],
        claim({
          id: "c5b",
          eventId: "e7",
          type: "process_failure",
          text: "Chased again with no answer.",
          ts: "2024-09-30T03:05:00.000Z",
        }),
      ],
      notes: [],
      clientActors: ["priya nair"],
    });
    const chasers = metrics.find((metric) => metric.id === "chasers");
    expect(chasers?.determined).toBe(false);
  });
});

describe("report lanes", () => {
  it("extends owner activity to uncited stored records", () => {
    const localEvents = [
      event({ id: "a1", ts: "2024-09-10T03:00:00.000Z", actor: "Marcus Webb", channel: "MER-9", text: "start" }),
      event({
        id: "a2",
        ts: "2024-09-14T03:00:00.000Z",
        actor: "Marcus Webb",
        source: "slack",
        channel: "meridian-billing",
        text: "uncited but real work",
      }),
    ];
    const lanes = buildLanes({
      events: localEvents,
      claims: [claim({ id: "k1", eventId: "a1", ts: "2024-09-10T03:00:00.000Z" })],
      notes: [],
    });
    const marcus = lanes.find((lane) => lane.actor === "Marcus Webb");
    expect(marcus?.end).toBe("2024-09-14T03:00:00.000Z");
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

    const claimRows = allRows.filter((row) => row.kind === "claim");
    const ids = claimRows.map((row) => (row.kind === "claim" ? row.claimId : ""));
    expect(ids).not.toContain("c6");
    expect(
      claimRows.every((row) => row.kind === "claim" && row.verification === "verified"),
    ).toBe(true);
  });
});

describe("commitment clustering", () => {
  it("merges near-duplicate promises and lets a broken reading outweigh a kept one", () => {
    const duplicateClaims: Claim[] = [
      claim({
        id: "d1",
        eventId: "e3",
        type: "commitment",
        text: "Ravi promised the fix would be out by end of week.",
        status: "kept",
        ts: "2024-09-24T16:00:00.000Z",
      }),
      claim({
        id: "d2",
        eventId: "e3",
        type: "commitment",
        text: "ravi_m promised in eng that the fix would ship by end of week.",
        status: "broken",
        ts: "2024-09-24T16:00:00.000Z",
      }),
      claim({
        id: "d3",
        eventId: "e6",
        type: "commitment",
        text: "The client promised to file the renewal paperwork.",
        status: "kept",
        ts: "2024-09-27T03:05:00.000Z",
      }),
    ];

    const ledger = buildLedger({ events, claims: duplicateClaims, notes: [] });
    expect(ledger).toHaveLength(2);
    expect(ledger[0].outcome).toBe("broken");
    expect(ledger[0].mergedClaims).toBe(2);
    expect(ledger[1].outcome).toBe("kept");

    const metrics = buildMetrics({ events, claims: duplicateClaims, notes: [] });
    expect(metrics.find((metric) => metric.id === "commitments")).toMatchObject({ value: "1 of 2 broken" });
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

  it("pairs contradictory Slack records even when no email is involved", () => {
    const slackClient = event({
      id: "s1",
      ts: "2024-09-26T10:00:00.000Z",
      source: "slack",
      actor: "Marcus Webb",
      channel: "seedX-client",
      text: "The fix is done and rolling out to you today.",
    });
    const slackInternal = event({
      id: "s2",
      ts: "2024-09-26T11:00:00.000Z",
      source: "slack",
      actor: "Lin Chen",
      channel: "seedX-eng",
      text: "The fix is still on a branch, nothing was deployed.",
    });

    const audit = buildAudit({
      events: [...events, slackClient, slackInternal],
      claims,
      notes: [
        {
          id: "n3",
          investigationId: "inv",
          kind: "contradiction",
          text: "Client channel claims a rollout that engineering says did not happen.",
          eventIds: ["s1", "s2"],
        },
      ],
    });

    expect(audit).toHaveLength(1);
    expect(audit[0].toldEventId).toBe("s1");
    expect(audit[0].internalEventId).toBe("s2");
  });

  it("splits verified findings into safe-to-repeat and check-with-human", () => {
    const supported = claim({
      id: "c7",
      eventId: "e1",
      verifyStatus: "supported",
      verifyError: "ts_mismatch",
      text: "A finding recorded while the contributor is unsure.",
    });
    const trust = buildTrust({ events, claims: [...claims, supported], notes });

    expect(trust.safeToRepeat.map((item) => item.claimId)).toEqual(["c1", "c2", "c3", "c5"]);
    expect(trust.checkWithHuman.map((item) => item.claimId)).toEqual(["c4", "c7"]);
    expect(
      trust.checkWithHuman.find((item) => item.claimId === "c7")?.verification,
    ).toBe("supported");
    expect(
      trust.safeToRepeat.every((item) => item.verification === "verified"),
    ).toBe(true);
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
    expect(view.audit).toHaveLength(2);
    expect(view.lanes.length).toBeGreaterThan(0);
    expect(view.causes.length).toBeGreaterThan(0);
  });
});

/* G-05: once the commitments entity exists, one merged commitment renders
   one canonical ledger row. (Raw claim clustering remains the fallback for
   legacy runs and is intentionally weaker on loose wordings.) */
describe("commitment dedupe (G-05)", () => {
  it("renders one row for a merged commitment across three sources", () => {
    const commitment: Commitment = {
      id: "cm1",
      investigationId: "p0",
      claimId: "f3-c-jira",
      issueId: null,
      promisor: "Marcus Webb",
      promisee: "Northwind",
      object: "invoice totals corrected",
      conditions: null,
      deadlinePhrase: "Sep 24",
      deadlineIso: "2024-09-24T00:00:00.000Z",
      rationale: "sources disagree on the outcome (broken vs kept vs unclear)",
      status: "broken",
      contested: true,
      fulfilmentEventIds: [],
      sourceEventIds: ["f3-jira", "f3-slack", "f3-email"],
      dedupeKey: "marcus webb|northwind|corrected invoice totals|2024-09-24",
      createdAt: "2024-09-20T10:00:00.000Z",
    };

    const rows = buildLedger({ ...duplicatePromise, commitments: [commitment] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claimId: "f3-c-jira",
      outcome: "broken",
      contested: true,
      mergedClaims: 3,
      deadline: "Sep 24",
    });
  });

  it("drops a commitment whose backing claim is not visible", () => {
    const commitment: Commitment = {
      id: "cm2",
      investigationId: "p0",
      claimId: "f3-c-jira",
      issueId: null,
      promisor: "Marcus Webb",
      promisee: null,
      object: "invoice totals corrected",
      conditions: null,
      deadlinePhrase: "Sep 24",
      deadlineIso: "2024-09-24T00:00:00.000Z",
      rationale: null,
      status: "broken",
      contested: false,
      fulfilmentEventIds: [],
      sourceEventIds: ["f3-jira"],
      dedupeKey: "key",
      createdAt: "2024-09-20T10:00:00.000Z",
    };
    const claims = duplicatePromise.claims.map((claim) =>
      claim.id === "f3-c-jira" ? { ...claim, verifyStatus: "rejected" as const } : claim,
    );

    expect(buildLedger({ ...duplicatePromise, claims, commitments: [commitment] })).toHaveLength(0);
  });
});

/* G-04 ratchet: a lateness larger than the whole evidence window cannot be
   real — the ledger must render it as an invalid date, never as a number a
   manager might repeat to a client. */
describe("deadline sanity (G-04)", () => {
  it("refuses a lateness beyond the incident window", () => {
    const events: Event[] = [
      event({ id: "w1", ts: "2024-09-10T03:00:00.000Z" }),
      event({ id: "w2", ts: "2024-09-30T03:00:00.000Z" }),
    ];
    const claims: Claim[] = [
      claim({
        id: "cw",
        eventId: "w1",
        type: "commitment",
        text: "We will ship by Mar 15.",
        ts: "2024-09-10T03:00:00.000Z",
        status: "broken",
      }),
    ];

    const rows = buildLedger({ events, claims, notes: [] });

    expect(rows[0].deadlineInvalid).toBe(true);
    expect(rows[0].daysLate).toBeNull();
  });

  it("keeps an in-window lateness as a number", () => {
    const events: Event[] = [
      event({ id: "w1", ts: "2024-09-10T03:00:00.000Z" }),
      event({ id: "w2", ts: "2024-09-25T03:00:00.000Z" }),
    ];
    const claims: Claim[] = [
      claim({
        id: "cw",
        eventId: "w2",
        type: "commitment",
        text: "We will ship by Sep 20.",
        ts: "2024-09-25T03:00:00.000Z",
        status: "broken",
      }),
    ];

    const rows = buildLedger({ events, claims, notes: [] });

    expect(rows[0].deadlineInvalid).toBe(false);
    expect(rows[0].daysLate).toBe(5);
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

  it("drops sentences that cite numbers the findings do not contain", () => {
    const claimsById = new Map([
      ["c1", { text: "A timezone change in release 4.12 caused the totals error.", quote: "4.12" }],
      ["c2", { text: "The promised Sep 24 fix did not ship.", quote: "Sep 24" }],
    ]);

    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "v",
        sentences: [
          { text: "The fix will now ship in release 5.3.5 on Oct 3.", claimIds: ["c1"] },
          { text: "The promised Sep 24 fix did not ship.", claimIds: ["c2"] },
        ],
      }),
      known,
      claimsById,
    );

    expect(result?.sentences.map((sentence) => sentence.text)).toEqual([
      "The promised Sep 24 fix did not ship.",
    ]);
  });

  it("drops a sentence that asserts a status the case state does not carry", async () => {
    const { buildCaseState } = await import("../lib/report/case-state");
    const caseState = buildCaseState({
      events: [
        event({ id: "cs1", ts: "2024-09-20T10:00:00.000Z", text: "Status: Open → In Progress" }),
      ],
      claims: [],
      clientDomains: [],
    });
    const claimsById = new Map([
      ["c1", { text: "A timezone change caused the totals error.", quote: "timezone change" }],
    ]);

    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "v",
        sentences: [
          { text: "The issue is resolved and closed.", claimIds: ["c1"] },
          { text: "The issue remains in progress.", claimIds: ["c1"] },
        ],
      }),
      new Set(["c1"]),
      claimsById,
      caseState,
    );

    expect(result?.sentences.map((sentence) => sentence.text)).toEqual([
      "The issue remains in progress.",
    ]);
  });

  it("drops ownership claims that contradict the case state", async () => {
    const { buildCaseState } = await import("../lib/report/case-state");
    const caseState = buildCaseState({
      events: [
        event({ id: "cs1", ts: "2024-09-20T10:00:00.000Z", text: "Assignee: Unassigned → Lin Chen" }),
      ],
      claims: [],
      clientDomains: [],
    });
    const claimsById = new Map([
      ["c1", { text: "A timezone change caused the totals error.", quote: "timezone change" }],
    ]);

    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "v",
        sentences: [
          { text: "The work was handed off to Marcus.", claimIds: ["c1"] },
          { text: "The work was handed off to Lin Chen.", claimIds: ["c1"] },
        ],
      }),
      new Set(["c1"]),
      claimsById,
      caseState,
    );

    expect(result?.sentences.map((sentence) => sentence.text)).toEqual([
      "The work was handed off to Lin Chen.",
    ]);
  });

  it("prunes a stored reply whose cited findings have degraded", () => {
    const stored = {
      sentences: [
        { text: "Verified claim sentence.", claimIds: ["c-still-good"] },
        { text: "Degraded claim sentence.", claimIds: ["c-degraded"] },
        { text: "Mixed sentence.", claimIds: ["c-still-good", "c-degraded"] },
      ],
    };
    const claims: Claim[] = [
      claim({ id: "c-still-good", eventId: "e1", text: "fine", verifyStatus: "verified", skepticFlag: false }),
      claim({ id: "c-degraded", eventId: "e1", text: "worse", verifyStatus: "supported", skepticFlag: false }),
    ];

    const pruned = pruneStaleReply(stored, claims);

    expect(pruned?.sentences.map((sentence) => sentence.text)).toEqual(["Verified claim sentence."]);

    const allBad = pruneStaleReply(stored, [
      claim({ id: "c-still-good", eventId: "e1", text: "fine", verifyStatus: "rejected" }),
      claim({ id: "c-degraded", eventId: "e1", text: "worse", verifyStatus: "rejected" }),
    ]);
    expect(allBad).toBeNull();
  });
});
