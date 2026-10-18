import { describe, expect, it } from "vitest";

import { buildReportModel, fullFindingLabel, shortFindingLabel, type ReportModelInput } from "../lib/report/model";
import type { Claim, Event, InvestigationScope } from "../lib/types";

const event = (over: Partial<Event> & { id: string; ts: string; text: string }): Event => ({
  investigationId: "inv",
  source: "jira",
  actor: "Priya Nair",
  channel: "MER-101",
  ...over,
});

const claim = (over: Partial<Claim> & { id: string; eventId: string; text: string }): Claim => ({
  investigationId: "inv",
  agent: "root_cause",
  type: "root_cause",
  quote: "quote",
  status: "n/a",
  confidence: 0.8,
  verifyStatus: "unverified",
  skepticFlag: false,
  ...over,
});

const events: Event[] = [
  event({
    id: "e1",
    ts: "2024-09-10T03:00:00.000Z",
    text: "Issue created: Timezone totals wrong 8d1a3d0e-1111-2222-3333-444455556666",
  }),
  event({
    id: "e2",
    ts: "2024-09-10T04:00:00.000Z",
    actor: "Lin Chen",
    text: "Assignee: Unassigned → Lin Chen",
  }),
  event({
    id: "e3",
    ts: "2024-09-24T01:30:00.000Z",
    source: "email",
    channel: "email",
    actor: "Priya Nair <priya@northwind.example>",
    text: "Totals are still wrong after the 4.12 release.",
  }),
];

const claims: Claim[] = [
  claim({
    id: "c1",
    eventId: "e3",
    type: "process_failure",
    text: "The client says totals are still wrong after release 4.12.",
    actor: "Priya Nair",
  }),
  claim({
    id: "c2",
    eventId: "e3",
    type: "process_failure",
    text: "Totals are still wrong after the 4.12 release, the client reports.",
    actor: "Priya Nair",
  }),
  claim({
    id: "c3",
    eventId: "e2",
    type: "ownership",
    text: "Lin Chen took ownership of MER-101.",
    actor: "Lin Chen",
  }),
];

const input = (over: Partial<ReportModelInput> = {}): ReportModelInput => ({
  investigation: {
    title: "MER-101: Issue created: Timezone totals wrong 8d1a3d0e-1111-2222-3333-444455556666",
    escalationText: "Client says totals are wrong since 4.12.",
    createdAt: "2024-09-10T03:00:00.000Z",
  },
  events,
  claims,
  commitments: [],
  gaps: [],
  notes: [],
  scope: null,
  clientDomains: [],
  clientActors: [],
  ...over,
});

describe("client and project resolve independently (B2)", () => {
  const declaredOnly: InvestigationScope = {
    client: "Northwind Logistics",
    project: null,
    ticketPrefixes: ["MER"],
    channels: ["meridian-billing"],
    senderDomains: ["northwind.example"],
    confidence: "partial",
    anchors: [{ kind: "declared-client", value: "Northwind Logistics", source: "declared" }],
  };

  it("a declared client is known even when no project string exists", () => {
    const model = buildReportModel(
      input({ scope: { ...declaredOnly, channels: [] }, clientDomains: ["northwind.example"] }),
    );
    expect(model.client.clientKnown).toBe(true);
    expect(model.client.client).toBe("Northwind Logistics");
    // The project is not named by a string, but the selected ticket prefix is.
    expect(model.client.projectKnown).toBe(true);
    expect(model.client.projectLabel).toContain("MER");
    expect(model.client.resolved).toBe(true);
  });

  it("a channel-only scope still names the project", () => {
    const model = buildReportModel(
      input({
        scope: { ...declaredOnly, ticketPrefixes: [], channels: ["meridian-billing"] },
      }),
    );
    expect(model.client.projectKnown).toBe(true);
    expect(model.client.projectLabel).toContain("meridian-billing");
  });

  it("the confirm action appears only when no client can be established", () => {
    const model = buildReportModel(
      input({ scope: { ...declaredOnly, client: null, confidence: "none" } }),
    );
    expect(model.client.clientKnown).toBe(false);
    expect(model.client.resolved).toBe(false);
    expect(model.headline.nextStep).toContain("Confirm the client");
  });
});

describe("role evidence (B4)", () => {
  const trapEvents: Event[] = [
    event({
      id: "e-r1",
      source: "email",
      channel: "email",
      ts: "2024-09-20T09:00:00.000Z",
      actor: "Pat Lee <pat@client.example>",
      text: "Chasing: is the fix out? Our finance team is blocked.",
      meta: { messageId: "m1", from: "pat@client.example", to: ["vendor@meridian.example"] },
    }),
    event({
      id: "e-r2",
      source: "email",
      channel: "email",
      ts: "2024-09-21T09:00:00.000Z",
      actor: "Alex Chen <alex@client.example>",
      text: "We will ship the fix in the Sep 24 release. I am on leave from tomorrow.",
      meta: { messageId: "m2", from: "alex@client.example", to: ["pat@client.example"] },
    }),
    event({
      id: "e-r3",
      source: "slack",
      ts: "2024-09-23T09:00:00.000Z",
      channel: "vendor-billing",
      actor: "Alex Chen",
      text: "Marking MER-101 resolved; the fix is in the build.",
    }),
    event({
      id: "e-r4",
      source: "email",
      channel: "email",
      ts: "2024-09-22T09:00:00.000Z",
      actor: "Sam Ray <sam@meridian.example>",
      text: "Build is going out tonight; the invoice fix is included.",
      meta: { messageId: "m3", from: "sam@meridian.example", to: ["pat@client.example"] },
    }),
    event({
      id: "e-r5",
      source: "slack",
      ts: "2024-09-24T09:00:00.000Z",
      channel: "support-room",
      actor: "Robin Wu",
      text: "Chasing the status again.",
    }),
  ];
  const scopeB4: InvestigationScope = {
    client: "Client Corp",
    project: "Meridian",
    ticketPrefixes: ["MER"],
    channels: [],
    senderDomains: ["client.example"],
    confidence: "partial",
    anchors: [{ kind: "declared-client", value: "Client Corp", source: "declared" }],
  };

  it("scores roles from domain, direction and channel evidence with the evidence listed", () => {
    const model = buildReportModel(
      input({ events: trapEvents, scope: scopeB4, clientDomains: ["client.example"], clientActors: [] }),
    );
    const byName = (name: string) => model.actors.find((actor) => actor.name === name);

    expect(byName("Pat Lee")?.role).toBe("client");
    expect(byName("Pat Lee")?.roleEvidence.join(" ")).toMatch(/client/i);

    // The trap: a client-domain address whose only email stayed inside the
    // client's own domain while doing vendor-side work in the project channel.
    expect(byName("Alex Chen")?.role).toBe("internal");
    expect(byName("Alex Chen")?.roleEvidence.join(" ")).toMatch(/internal|vendor|never/i);

    expect(byName("Sam Ray")?.role).toBe("internal");

    // A slack-only participant with no evidence either way stays unknown,
    // with the ambiguity disclosed rather than guessed.
    expect(byName("Robin Wu")?.role).toBe("unknown");
    expect(byName("Robin Wu")?.roleEvidence.length).toBeGreaterThan(0);
  });
});

describe("assertion clusters (A1)", () => {
  it("a verified claim survives supported restatements on the same record", () => {
    const events = [event({ id: "e-agg", ts: "2024-09-10T03:00:00.000Z", text: "Timezone change merged for release 4.12." })];
    const claims = [
      claim({ id: "c-strong", eventId: "e-agg", type: "root_cause", text: "The 4.12 timezone merge introduced the invoice defect.", verifyStatus: "verified", confidence: 0.9 }),
      claim({ id: "c-weak-1", eventId: "e-agg", type: "root_cause", text: "The 4.12 timezone merge introduced the invoice defect.", verifyStatus: "supported", confidence: 0.5 }),
      claim({ id: "c-weak-2", eventId: "e-agg", type: "root_cause", text: "The timezone merge introduced the invoice defect.", verifyStatus: "supported", confidence: 0.4 }),
    ];
    const model = buildReportModel(input({ events, claims }));
    const finding = model.findings[0];
    expect(finding.verification).toBe("verified");
    expect(finding.claimIds.sort()).toEqual(["c-strong", "c-weak-1", "c-weak-2"]);
    expect(model.counts.verified).toBe(model.findings.filter((f) => f.verification === "verified" && f.pill === null).length);
    expect(finding.flags).not.toContain("conflict");
  });

  it("incompatible assertions on one record raise a conflict instead of choosing", () => {
    const events = [event({ id: "e-conf", ts: "2024-09-10T03:00:00.000Z", text: "Timezone change merged for release 4.12." })];
    const claims = [
      claim({ id: "c-res", eventId: "e-conf", type: "ownership", text: "The ticket was marked resolved.", verifyStatus: "verified", confidence: 0.9 }),
      claim({ id: "c-fail", eventId: "e-conf", type: "ownership", text: "The build is still failing QA on the same day.", verifyStatus: "supported", confidence: 0.7 }),
    ];
    const model = buildReportModel(input({ events, claims }));
    expect(model.findings[0].flags).toContain("conflict");
  });
});

describe("ReportModel revision brief", () => {
  it("deduplicates claims per record and keeps every claim id", () => {
    const model = buildReportModel(input());
    expect(model.findings).toHaveLength(3);
    const emailFinding = model.findings.find((finding) => finding.eventIds.includes("e3"));
    expect(emailFinding?.claimIds.sort()).toEqual(["c1", "c2"]);
    expect(new Set(model.findings.map((finding) => finding.id)).size).toBe(3);
  });

  it("strips the record prefix and UUID from the title and finding text", () => {
    const model = buildReportModel(input());
    expect(model.title).toBe("Timezone totals wrong");
    expect(model.title).not.toMatch(/MER-101|8d1a3d0e/);
    expect(model.findings.some((finding) => /8d1a3d0e|Issue created:/.test(finding.text))).toBe(false);
  });

  it("classifies ownership as an event, never a failure", () => {
    const model = buildReportModel(input());
    const ownership = model.findings.find((finding) => finding.eventIds.includes("e2"));
    expect(ownership?.kind).toBe("status_change");
    expect(ownership?.failureTag).toBeNull();
    expect(ownership?.text).toContain("Lin Chen took ownership");
    expect(model.failures.some((finding) => finding.id === ownership?.id)).toBe(false);
  });

  it("keeps state, counts and lists consistent", () => {
    const model = buildReportModel(input());
    expect(model.counts.findings).toBe(model.findings.length);
    expect(model.counts.verified).toBe(
      model.findings.filter((finding) => finding.verification === "verified").length,
    );
    expect(model.counts.needsCheck).toBe(
      model.findings.filter((finding) => finding.pill !== null).length,
    );
    expect(model.counts.openQuestions).toBe(model.openQuestions.length);

    expect(model.state.owner).toMatchObject({ known: true, value: "Lin Chen" });
    expect(model.state.owner.basis).toHaveLength(1);
    expect(model.findings.some((finding) => finding.id === model.state.owner.basis[0])).toBe(true);
    // Roles cannot be guessed before the client is identified; the last
    // internal update is still knowable from records alone (C1).
    expect(model.state.lastClientContact.known).toBe(false);
    expect(model.state.lastClientContact.unknownReason).toMatch(/client evidence/i);
    expect(model.state.lastInternalUpdate.known).toBe(true);
    expect(model.client.resolved).toBe(false);
    expect(model.actors.every((actor) => actor.role === "unknown")).toBe(true);
  });

  it("writes a 2-3 sentence story with finding citations and a muted stats line", () => {
    const model = buildReportModel(input());
    expect(model.headline.sentences.length).toBeGreaterThanOrEqual(2);
    expect(model.headline.sentences.length).toBeLessThanOrEqual(3);
    expect(model.headline.sentences.every((sentence) => sentence.findingIds.length > 0)).toBe(true);
    expect(model.headline.statsLine).toContain("3 findings");
    expect(model.headline.statsLine).toContain(`${model.counts.openQuestions} open questions`);
    expect(model.headline.tooThin).toBe(true);
    expect(model.headline.nextStep).toContain("Confirm the client");
  });

  it("groups open questions with next steps", () => {
    const model = buildReportModel(input());
    expect(model.openQuestions.length).toBeGreaterThanOrEqual(4);
    for (const group of model.openQuestions) {
      expect(group.question.length).toBeGreaterThan(0);
      expect(group.nextStep.length).toBeGreaterThan(0);
      expect(group.count).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(model.openQuestions.map((group) => group.theme)).size).toBe(
      model.openQuestions.length,
    );
  });

  it("generates actions only from findings and suppresses repeated pills", () => {
    const model = buildReportModel(input());
    expect(model.actions.length).toBeGreaterThan(0);
    if (model.actions[0].id !== "act_none") {
      expect(model.actions[0].findingIds.length).toBeGreaterThan(0);
    }
    expect(model.actions.every((action) => !/reply|draft/i.test(action.text))).toBe(true);
    expect(model.suppressPills).toBe(true);
    expect(model.pillSummary).toContain("Needs check");
  });

  it("never repeats an 8+ word sentence between the headline and the findings", () => {
    const model = buildReportModel(input());
    const sentences = [
      ...model.headline.sentences.map((sentence) => sentence.text),
      ...model.findings.map((finding) => finding.text),
    ]
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter((text) => text.split(" ").length >= 8);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("resolves roles and last contact once the client is confirmed", () => {    const scope: InvestigationScope = {
      client: "Northwind Logistics",
      project: "Meridian",
      ticketPrefixes: ["MER"],
      channels: [],
      senderDomains: ["northwind.example"],
      confidence: "scoped",
      anchors: [{ kind: "declared-client", value: "Northwind Logistics", source: "declared" }],
    };
    const resolvedEvents = events.map((entry) =>
      entry.id === "e2"
        ? { ...entry, actor: "Lin Chen <lin@meridian.example>" }
        : entry,
    );
    const model = buildReportModel(
      input({
        events: resolvedEvents,
        scope,
        clientDomains: ["northwind.example"],
        clientActors: [],
      }),
    );
    expect(model.client.resolved).toBe(true);
    expect(model.actors.find((actor) => actor.name === "Priya Nair")?.role).toBe("client");
    expect(model.actors.find((actor) => actor.name === "Lin Chen")?.role).toBe("internal");
    expect(model.state.lastClientContact).toMatchObject({ known: true });
    expect(model.state.lastClientContact.value?.actor).toBe("Priya Nair");
    expect(model.state.lastInternalUpdate).toMatchObject({ known: true });
    expect(model.state.lastInternalUpdate.value?.actor).toBe("Lin Chen");
  });

  it("merges the same actor's restatement across Jira and Slack and keeps the tentative wording", () => {
    const restatementEvents: Event[] = [
      event({
        id: "e_restate_jira",
        ts: "2024-09-23T04:05:00.000Z",
        actor: "Marcus Webb",
        channel: "MER-101",
        text: "Root cause looks like the MER-87 timezone change. Fix scheduled for the Sep 24 release.",
      }),
      event({
        id: "e_restate_slack",
        ts: "2024-09-23T04:30:00.000Z",
        source: "slack",
        actor: "Marcus Webb",
        channel: "meridian-billing",
        text: "MER-87 timezone change is the cause. Fix targeted at the Sep 24 release.",
      }),
    ];
    const restatementClaims: Claim[] = [
      claim({
        id: "c_restate_jira",
        eventId: "e_restate_jira",
        type: "root_cause",
        actor: "Marcus Webb",
        text: "Marcus Webb attributed the wrong invoice totals to the MER-87 timezone change (root cause assessed as likely, not yet confirmed).",
        quote: "Root cause looks like the MER-87 timezone change.",
      }),
      claim({
        id: "c_restate_slack",
        eventId: "e_restate_slack",
        type: "root_cause",
        actor: "Marcus Webb",
        text: "Marcus Webb confirmed internally that the MER-87 timezone change is the cause.",
        quote: "MER-87 timezone change is the cause.",
      }),
    ];
    const model = buildReportModel(
      input({ events: restatementEvents, claims: restatementClaims, gaps: [], notes: [] }),
    );
    const merged = model.findings.filter(
      (finding) =>
        finding.eventIds.includes("e_restate_jira") &&
        finding.eventIds.includes("e_restate_slack"),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].claimIds.sort()).toEqual(["c_restate_jira", "c_restate_slack"]);
    expect(merged[0].text).toContain("likely");
    expect(merged[0].text).not.toContain("confirmed internally");
    expect(merged[0].quotes[0]).toContain("looks like");
  });
  /* The live failure: closure/status statements ("told X that T was
     resolved", "was reported fixed", "stated she verified and closed") were
     rendered as promises, and labels printed the promisor twice. */
  it("closure statements never enter the promises list (G-05)", () => {
    const closureEvents: Event[] = [
      event({
        id: "ce1",
        ts: "2024-09-21T08:00:00.000Z",
        text: "Ravi Menon told orbit-support on 21 Sep that ORB-101 was resolved because the VAT fix is in 2.1.3.",
      }),
    ];
    const closureClaims: Claim[] = [
      claim({
        id: "cc1",
        eventId: "ce1",
        type: "commitment",
        text: "Ravi Menon told orbit-support on 21 Sep that ORB-101 was resolved because the VAT fix is in 2.1.3.",
        status: "unclear",
      }),
    ];

    const model = buildReportModel(input({ events: closureEvents, claims: closureClaims }));

    expect(model.promises).toHaveLength(0);
    // It remains a visible finding — just not a promise.
    expect(model.findings.length).toBeGreaterThan(0);
  });

  it("keeps a real commitment and never prints the promisor twice", () => {
    const promiseEvents: Event[] = [
      event({
        id: "pe1",
        ts: "2024-09-20T10:00:00.000Z",
        actor: "Ravi Menon",
        text: "Ravi Menon committed the VAT fix to the Sep 20 release.",
      }),
    ];
    const promiseClaims: Claim[] = [
      claim({
        id: "pc1",
        eventId: "pe1",
        type: "commitment",
        text: "Ravi Menon committed the VAT fix to the Sep 20 release.",
        actor: "Ravi Menon",
        status: "broken",
      }),
    ];

    const model = buildReportModel(input({ events: promiseEvents, claims: promiseClaims }));

    expect(model.promises).toHaveLength(1);
    const label = shortFindingLabel(model.promises[0], model.actors);
    expect(label).not.toMatch(/promised Ravi Menon/i);
    expect(label).toMatch(/^Ravi Menon (?:committed|promised)/);
  });

  it("the full label is the untruncated sentence and the short label keeps the cap", () => {
    const promiseEvents: Event[] = [
      event({
        id: "pe2",
        ts: "2024-09-20T10:00:00.000Z",
        actor: "Ravi Menon",
        text: "Ravi Menon committed the VAT fix to the Sep 20 release.",
      }),
    ];
    const promiseClaims: Claim[] = [
      claim({
        id: "pc2",
        eventId: "pe2",
        type: "commitment",
        text: "Ravi Menon committed the VAT fix to the Sep 20 release.",
        actor: "Ravi Menon",
        status: "broken",
      }),
    ];

    const model = buildReportModel(input({ events: promiseEvents, claims: promiseClaims }));
    const finding = model.promises[0];

    expect(fullFindingLabel(finding, model.actors)).toBe(
      "Ravi Menon committed the VAT fix to the Sep 20 release.",
    );
    const short = shortFindingLabel(finding, model.actors);
    expect(short.endsWith("…")).toBe(true);
    expect(short).not.toBe(fullFindingLabel(finding, model.actors));
  });

  it("event labels derive from the full text: the short label is its capped prefix", () => {
    const text = "Totals are still wrong after the 4.12 release despite the timezone fix being deployed.";
    const model = buildReportModel(
      input({
        events: [event({ id: "le1", ts: "2024-09-24T01:30:00.000Z", text })],
        claims: [],
      }),
    );
    const finding = model.findings[0];

    const full = fullFindingLabel(finding, model.actors);
    expect(full).toBe(text);
    expect(full).not.toContain("…");

    const short = shortFindingLabel(finding, model.actors);
    expect(short.endsWith("…")).toBe(true);
    expect(full.startsWith(short.replace(/…$/, ""))).toBe(true);
  });

  it("action text names the promise owner instead of Someone", () => {
    const promiseEvents: Event[] = [
      event({
        id: "pe3",
        ts: "2024-09-20T10:00:00.000Z",
        actor: "Ravi Menon",
        text: "Ravi Menon committed the VAT fix to the Sep 20 release.",
      }),
    ];
    const promiseClaims: Claim[] = [
      claim({
        id: "pc3",
        eventId: "pe3",
        type: "commitment",
        text: "Ravi Menon committed the VAT fix to the Sep 20 release.",
        actor: "Ravi Menon",
        status: "broken",
      }),
    ];

    const model = buildReportModel(input({ events: promiseEvents, claims: promiseClaims }));

    expect(model.actions[0].text).toContain("Ravi Menon");
    expect(model.actions[0].text).not.toContain("Someone");
  });

  it("machine type prefixes are stripped and quote-style promises label with a colon", () => {
    const rawText =
      "Commitment finding: As discussed on our call, Meridian carries a contractual SLA on invoice accuracy.";
    const actor = "Priya Nair <priya@northwind.example>";
    const model = buildReportModel(
      input({
        events: [event({ id: "qp1", ts: "2024-09-20T10:00:00.000Z", actor, text: rawText })],
        claims: [claim({ id: "qc1", eventId: "qp1", type: "commitment", text: rawText, actor, status: "broken" })],
      }),
    );
    const finding = model.promises[0];

    expect(finding.text).not.toContain("finding:");
    const label = shortFindingLabel(finding, model.actors);
    expect(label.startsWith("Priya Nair: ")).toBe(true);
    expect(label).not.toMatch(/promised [A-Z]/);
    expect(fullFindingLabel(finding, model.actors)).toBe(
      "Priya Nair: As discussed on our call, Meridian carries a contractual SLA on invoice accuracy.",
    );
  });

  it("a broken promise ranks above conflicts from older findings", () => {
    const model = buildReportModel(
      input({
        events: [
          event({
            id: "ap1",
            ts: "2024-09-10T03:00:00.000Z",
            text: "The exported totals were off by a day since the upgrade.",
          }),
          event({
            id: "ap2",
            ts: "2024-09-20T10:00:00.000Z",
            actor: "Ravi Menon",
            text: "Ravi Menon committed the VAT fix to the Sep 20 release.",
          }),
        ],
        claims: [
          claim({
            id: "ac1",
            eventId: "ap1",
            type: "root_cause",
            text: "The exported totals were off by a day since the upgrade.",
            skepticFlag: true,
          }),
          claim({
            id: "ac2",
            eventId: "ap2",
            type: "commitment",
            text: "Ravi Menon committed the VAT fix to the Sep 20 release.",
            actor: "Ravi Menon",
            status: "broken",
          }),
        ],
      }),
    );

    expect(model.actions[0].text).toContain("Close out the broken promise");
    expect(model.actions.some((action) => action.text.includes("Resolve the conflict"))).toBe(true);
  });

  it("a client's own fix wording never grounds the latest-fix card", () => {
    const model = buildReportModel(
      input({
        scope: {
          client: "Northwind Logistics",
          project: "Meridian",
          ticketPrefixes: ["MER"],
          channels: [],
          senderDomains: ["northwind.example"],
          confidence: "scoped",
          anchors: [],
        },
        clientDomains: ["northwind.example"],
        events: [
          event({
            id: "lf1",
            ts: "2024-09-30T08:00:00.000Z",
            actor: "Priya Nair <priya@northwind.example>",
            text: "The VAT fix for 2.1.0 was promised for Sep 20; both dates passed without a working fix.",
          }),
          event({
            id: "lf2",
            ts: "2024-09-28T09:45:00.000Z",
            actor: "Ravi Menon",
            text: "Fixed in 2.1.4; the VAT rounding path was corrected and deployed.",
          }),
        ],
        claims: [],
      }),
    );

    expect(model.state.latestFix.known).toBe(true);
    expect(model.state.latestFix.value?.text).toContain("Fixed in 2.1.4");
    expect(model.state.latestFix.value?.text).not.toContain("promised for Sep 20");
  });

});
