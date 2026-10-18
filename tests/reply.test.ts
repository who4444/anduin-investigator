import { describe, expect, it } from "vitest";

import { replyEligible, signOffFor, validateReplyPayload } from "../lib/agents/reply";
import { buildCaseState } from "../lib/report/case-state";
import type { Claim, Event, Issue, InvestigationScope } from "../lib/types";

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

const issue = (id: string, seq: number): Issue => ({
  id,
  investigationId: "inv",
  seq,
  title: `Issue ${seq}`,
  ask: "",
  summary: "",
  confidence: 0.9,
  confirmed: true,
  createdAt: "2024-09-10T00:00:00.000Z",
});

const scope = (over: Partial<InvestigationScope> = {}): InvestigationScope => ({
  client: "Northwind Logistics",
  project: "Meridian Billing",
  ticketPrefixes: ["MER"],
  channels: [],
  senderDomains: [],
  confidence: "scoped",
  anchors: [],
  ...over,
});

describe("reply sentence validation", () => {
  const causeClaim = claim({
    id: "c1",
    eventId: "e1",
    text: "A timezone change in release 4.12 caused the totals error.",
    quote: "Timezone change merged for release 4.12",
  });
  const claimsById = new Map([
    ["c1", { text: causeClaim.text, quote: causeClaim.quote, type: causeClaim.type }],
  ]);

  const resolvedState = buildCaseState({
    events: [
      event({ id: "s1", ts: "2024-09-20T10:00:00.000Z", text: "Status: Open → Resolved" }),
    ],
    claims: [causeClaim],
    clientDomains: [],
  });

  it("drops a sentence that asserts a status the current state does not carry", () => {
    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "v",
        sentences: [
          { text: "The issue remains open.", claimIds: ["c1"] },
          { text: "The issue was resolved after the release 4.12 timezone change.", claimIds: ["c1"] },
        ],
      }),
      new Set(["c1"]),
      claimsById,
      resolvedState,
    );

    expect(result?.sentences.map((sentence) => sentence.text)).toEqual([
      "The issue was resolved after the release 4.12 timezone change.",
    ]);
  });

  it("drops a sentence that claims verification when no such action is recorded", () => {
    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "v",
        sentences: [{ text: "We are verifying the totals error now.", claimIds: ["c1"] }],
      }),
      new Set(["c1"]),
      claimsById,
      resolvedState,
    );

    expect(result).toBeNull();
  });

  it("drops an invented commitment that no cited finding states", () => {
    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "v",
        sentences: [
          { text: "We will provide an update next week.", claimIds: ["c1"] },
          { text: "The release 4.12 timezone change caused the totals error.", claimIds: ["c1"] },
        ],
      }),
      new Set(["c1"]),
      claimsById,
      resolvedState,
    );

    expect(result?.sentences.map((sentence) => sentence.text)).toEqual([
      "The release 4.12 timezone change caused the totals error.",
    ]);
  });

  it("keeps a commitment sentence that cites the record stating it", () => {
    const promiseClaim = claim({
      id: "c2",
      eventId: "e2",
      type: "commitment",
      text: "The fix was promised for the September 24 release.",
      quote: "promised the fix for the Sep 24 release",
    });
    const promisesById = new Map([
      ["c2", { text: promiseClaim.text, quote: promiseClaim.quote, type: promiseClaim.type }],
    ]);

    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "v",
        sentences: [{ text: "The promised September 24 fix did not ship.", claimIds: ["c2"] }],
      }),
      new Set(["c2"]),
      promisesById,
      resolvedState,
    );

    expect(result?.sentences.map((sentence) => sentence.text)).toEqual([
      "The promised September 24 fix did not ship.",
    ]);
  });

  it("drops internal QA and process narration", () => {
    const result = validateReplyPayload(
      JSON.stringify({
        verdict: "v",
        sentences: [
          { text: "The resolution proceeded nonetheless after QA failed.", claimIds: ["c1"] },
          { text: "The release 4.12 timezone change caused the totals error.", claimIds: ["c1"] },
        ],
      }),
      new Set(["c1"]),
      claimsById,
      resolvedState,
    );

    expect(result?.sentences.map((sentence) => sentence.text)).toEqual([
      "The release 4.12 timezone change caused the totals error.",
    ]);
  });
});

describe("reply sign-off", () => {
  it("signs as the project vendor, never the product brand", () => {
    const signOff = signOffFor(scope());
    expect(signOff).toMatch(/Meridian/);
    expect(signOff).not.toMatch(/Anduin/i);
  });

  it("falls back to a neutral support identity when no project is named", () => {
    const signOff = signOffFor(scope({ project: null }));
    expect(signOff).toMatch(/Support team/);
    expect(signOff).not.toMatch(/Anduin/i);
  });
});

describe("reply eligibility", () => {
  const verified = claim({ id: "c1", eventId: "e1" });

  it("blocks an unresolved client", () => {
    const result = replyEligible({
      scope: null,
      claims: [verified],
      issues: [issue("i1", 1)],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/client is not identified/i);
  });

  it("blocks a scope with no named project or prefix", () => {
    const result = replyEligible({
      scope: scope({ project: null, ticketPrefixes: [], channels: [] }),
      claims: [verified],
      issues: [issue("i1", 1)],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/project|scope/i);
  });

  it("blocks when the only verified claim is a negative-absence claim", () => {
    const negative = claim({
      id: "c2",
      eventId: "e1",
      verifyError: "negative_inference",
    });
    const result = replyEligible({
      scope: scope(),
      claims: [negative],
      issues: [issue("i1", 1)],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/verified/i);
  });

  it("is eligible with a scoped client and a verified client-safe fact", () => {
    expect(
      replyEligible({ scope: scope(), claims: [verified], issues: [issue("i1", 1)] }),
    ).toEqual({ eligible: true, reason: null });
  });

  it("blocks a cross-tenant unscoped export until the engagement is confirmed", () => {
    const result = replyEligible({
      scope: scope(),
      claims: [verified],
      issues: [issue("i1", 1)],
      crossTenant: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/candidate engagement|engagement/i);
  });

  it("blocks excluded client evidence", () => {
    const result = replyEligible({
      scope: scope(),
      claims: [verified],
      issues: [issue("i1", 1)],
      excludedClientRecords: 2,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/excluded/i);
  });

  it("requires an issue id for a multi-issue run", () => {
    const result = replyEligible({
      scope: scope(),
      claims: [verified],
      issues: [issue("i1", 1), issue("i2", 2)],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/issue/i);
  });

  it("rejects an unknown issue id and facts from another issue", () => {
    const issues = [issue("i1", 1), issue("i2", 2)];
    expect(
      replyEligible({ scope: scope(), claims: [verified], issues, issueId: "ghost" }).eligible,
    ).toBe(false);

    const otherIssue = claim({ id: "c9", eventId: "e1", issueId: "i2" });
    const result = replyEligible({
      scope: scope(),
      claims: [otherIssue],
      issues,
      issueId: "i1",
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/verified/i);
  });
});
