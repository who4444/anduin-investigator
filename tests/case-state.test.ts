import { describe, expect, it } from "vitest";

import { buildCaseState } from "../lib/report/case-state";
import type { Commitment, Event } from "../lib/types";

const event = (over: Partial<Event> & { id: string; ts: string }): Event => ({
  investigationId: "inv",
  source: "jira",
  actor: "Lin Chen",
  channel: "MER-101",
  text: "text",
  ...over,
});

const commitment = (over: Partial<Commitment> & { id: string }): Commitment => ({
  investigationId: "inv",
  claimId: "cm-claim",
  issueId: null,
  promisor: "Marcus Webb",
  promisee: "Northwind",
  object: "invoice totals corrected",
  conditions: null,
  deadlinePhrase: "Oct 10",
  deadlineIso: "2024-10-10T00:00:00.000Z",
  rationale: null,
  status: "unclear",
  contested: false,
  fulfilmentEventIds: [],
  sourceEventIds: ["e5"],
  dedupeKey: "key",
  createdAt: "2024-09-20T10:00:00.000Z",
  ...over,
});

/* The incident: a premature resolve, a reopen, then a real fix. */
const baseEvents: Event[] = [
  event({ id: "e1", ts: "2024-09-20T10:00:00.000Z", text: "Status: Open → In Progress" }),
  event({ id: "e2", ts: "2024-09-26T10:00:00.000Z", actor: "Marcus Webb", text: "Status: In Progress → Resolved" }),
  event({
    id: "e3",
    ts: "2024-09-28T10:00:00.000Z",
    source: "email",
    channel: "email",
    actor: "Dana Okoro <dana.okafor@northwind.example>",
    text: "Reopening this — totals are still wrong.",
  }),
  event({ id: "e4", ts: "2024-09-30T10:00:00.000Z", text: "Status: Resolved → Reopened" }),
  event({
    id: "e5",
    ts: "2024-10-02T10:00:00.000Z",
    source: "slack",
    channel: "meridian-billing",
    actor: "Marcus Webb",
    text: "5.3.3 is live with the totals fix. QA passed on the new build.",
  }),
];

describe("buildCaseState (G-06)", () => {
  it("the latest transition wins — a reopen beats a premature Resolved", () => {
    const state = buildCaseState({ events: baseEvents, claims: [], clientDomains: [] });
    expect(state.currentStatus).toMatchObject({
      known: true,
      value: "Reopened",
      since: "2024-09-30T10:00:00.000Z",
    });
  });

  it("finds the latest version-bearing fix and its QA check", () => {
    const state = buildCaseState({ events: baseEvents, claims: [], clientDomains: [] });
    expect(state.latestFix).toMatchObject({ known: true });
    expect(state.latestFix.value?.text).toContain("5.3.3 is live");
    expect(state.fixCheck.value).toContain("QA passed");
  });

  it("prefers the latest version-bearing fix over an earlier release note", () => {
    const state = buildCaseState({
      events: [
        ...baseEvents,
        event({
          id: "e-fix-534",
          ts: "2024-10-04T10:00:00.000Z",
          actor: "Nadia Chen",
          text: "Root cause confirmed; 5.3.4 fixed the VAT rounding and exports verified.",
        }),
      ],
      claims: [],
      clientDomains: [],
    });
    expect(state.latestFix.value?.text).toContain("5.3.4 fixed");
  });

  it("does not treat the client's escalation email as the latest fix", () => {
    const state = buildCaseState({
      events: [
        ...baseEvents,
        event({
          id: "e-client-version",
          ts: "2024-10-05T10:00:00.000Z",
          source: "email",
          channel: "email",
          actor: "Dana Okoro <dana.okafor@northwind.example>",
          text: "Your 5.3.4 release is still broken; this escalation is about the missing fix.",
        }),
      ],
      claims: [],
      clientDomains: ["northwind.example"],
    });
    expect(state.latestFix.value?.text).toContain("5.3.3 is live");
    expect(state.latestFix.value?.text).not.toContain("escalation");
  });

  it("does not treat the release that introduced the defect as a fix", () => {
    const state = buildCaseState({
      events: [
        event({
          id: "e-defect-release",
          ts: "2024-09-10T03:00:00.000Z",
          text: "The UTC conversion was merged to release branch 4.12, and 4.12 is live on production as of this morning.",
        }),
        event({
          id: "e-qa-plan",
          ts: "2024-09-24T16:00:00.000Z",
          text: "Let us keep MER-101 open until QA passes.",
        }),
        event({
          id: "e-qa-fail",
          ts: "2024-09-25T09:00:00.000Z",
          text: "QA is still failing on the Sep 24 build.",
        }),
      ],
      claims: [],
      clientDomains: [],
    });
    expect(state.latestFix.known).toBe(false);
    expect(state.fixCheck.value).not.toContain("until QA passes");
    expect(state.fixCheck.value).toContain("still failing");
  });

  it("keeps the last assignment, and reads an unassignment as no owner", () => {
    const assigned = buildCaseState({
      events: [
        ...baseEvents,
        event({ id: "e6", ts: "2024-09-24T09:00:00.000Z", text: "Assignee: Unassigned → Lin Chen" }),
        event({ id: "e7", ts: "2024-09-25T09:00:00.000Z", text: "Assignee: Lin Chen → Ravi Menon" }),
      ],
      claims: [],
      clientDomains: [],
    });
    expect(assigned.owner.value).toBe("Ravi Menon");

    const unassigned = buildCaseState({
      events: [
        ...baseEvents,
        event({ id: "e8", ts: "2024-10-01T09:00:00.000Z", text: "Assignee: Ravi Menon → Unassigned" }),
      ],
      claims: [],
      clientDomains: [],
    });
    expect(unassigned.owner).toMatchObject({ known: false, value: null });
    expect(unassigned.owner.known ? "" : unassigned.owner.reason).toContain("unassigned");
  });

  it("names the last client contact by domain and the last internal update otherwise", () => {
    const state = buildCaseState({
      events: baseEvents,
      claims: [],
      clientDomains: ["northwind.example"],
    });
    expect(state.lastClientContact.value?.actor).toContain("dana.okafor@northwind.example");
    expect(state.lastInternalUpdate.value?.actor).toBe("Marcus Webb");
    expect(state.lastInternalUpdate.value?.ts).toBe("2024-10-02T10:00:00.000Z");
  });

  it("takes the earliest open dated commitment beyond the horizon", () => {
    const state = buildCaseState({
      events: baseEvents,
      claims: [],
      clientDomains: [],
      commitments: [
        commitment({ id: "c-past", deadlineIso: "2024-09-30T00:00:00.000Z" }),
        commitment({ id: "c-kept", status: "kept", deadlineIso: "2024-10-04T00:00:00.000Z" }),
        commitment({ id: "c-next", deadlineIso: "2024-10-10T00:00:00.000Z" }),
      ],
    });
    expect(state.nextCommitment.value?.object).toBe("invoice totals corrected");
    expect(state.nextCommitment.value?.deadline).toBe("2024-10-10T00:00:00.000Z");

    const none = buildCaseState({ events: baseEvents, claims: [], clientDomains: [] });
    expect(none.nextCommitment).toMatchObject({ known: false, value: null });
    expect(none.nextCommitment.known ? "" : none.nextCommitment.reason).toContain("no open promise");
  });

  it("stays honest on an empty record set", () => {
    const state = buildCaseState({ events: [], claims: [], clientDomains: [] });
    expect(state.asOf).toBe("");
    expect(state.currentStatus.known).toBe(false);
    expect(state.owner.known).toBe(false);
    expect(state.lastClientContact.known).toBe(false);
  });
});
