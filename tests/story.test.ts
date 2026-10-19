import { describe, expect, it } from "vitest";

import { buildStory, type StoryInput } from "../lib/report/story";
import { buildReportModel, type ReportModelInput } from "../lib/report/model";
import type { Claim, Commitment, Event, InvestigationScope } from "../lib/types";

const richStory: StoryInput = {
  cause: {
    statement: "the release 4.12 timezone change",
    ts: "2024-09-10T03:00:00.000Z",
    channel: "MER-101",
    state: "verified",
    findingIds: ["f1"],
  },
  promises: [
    {
      promisor: "Lin Chen",
      promisee: "Priya Nair",
      object: "the invoice totals fix",
      deadlinePhrase: "Sep 24",
      status: "broken",
      findingIds: ["f4"],
    },
  ],
  currentStatus: { known: true, value: "Resolved", findingIds: ["f5"] },
  statusChangedBy: { known: true, value: "Marcus Webb", findingIds: ["f5"] },
  lastClientContact: { known: true, chases: 3, findingIds: ["f6"] },
  latestFix: {
    known: true,
    text: "Fixed in 4.13; the UTC handling was corrected for every invoice line and redeployed to production.",
    findingIds: ["f7"],
  },
  openQuestion: {
    question: "Which change actually fixed the problem?",
    nextStep: "Ask the engineer for the deploy log.",
    findingIds: ["f8"],
  },
  recordCount: 12,
  counts: { findings: 8, verified: 3, needsCheck: 5, openQuestions: 2 },
  sources: ["jira", "slack", "email"],
};

const storyText = (input: StoryInput): string =>
  buildStory(input)
    .sentences.map((sentence) => sentence.text)
    .join(" ");

describe("answer-first story (D1)", () => {
  it("states the root cause, the promise outcome, the status and a next step", () => {
    const story = buildStory(richStory);
    const text = storyText(richStory);

    expect(text).toContain("the release 4.12 timezone change");
    expect(text).toContain("Lin Chen promised to Priya Nair: “the invoice totals fix” by Sep 24; it was broken.");
    expect(text).toContain("As of now: Resolved");
    expect(text).toContain("last status change by Marcus Webb");
    expect(text).toContain("the client has chased 3 times without a reply");
    expect(text).toContain("Still unknown: Which change actually fixed the problem?");
    expect(story.nextStep).toBe("Ask the engineer for the deploy log.");
    expect(story.tooThin).toBe(false);
    expect(story.statsLine).toContain("8 findings");
    expect(story.statsLine).toContain("2 open questions");
  });

  it("carries no finding-type metadata or severity-ordered record language", () => {
    const text = storyText(richStory);
    expect(text).not.toContain("the first record is");
    expect(text).not.toContain("the latest record is");
    expect(text).not.toMatch(/technical finding|a process failure|a status change\b/);
  });

  it("states an absent cause and an absent promise instead of guessing", () => {
    const story = buildStory({
      ...richStory,
      cause: null,
      promises: [],
      currentStatus: { known: false, value: null },
      statusChangedBy: { known: false, value: null },
      lastClientContact: { known: false, chases: null },
      latestFix: { known: false, text: null },
      openQuestion: null,
      recordCount: 12,
    });
    const text = story.sentences.map((sentence) => sentence.text).join(" ");
    expect(text).toContain("The records do not establish a technical cause.");
    expect(text).toContain("No client-facing promise was recorded.");
    expect(text).toContain("the current status is not recorded");
    expect(text).not.toContain("Still unknown:");
  });
});

describe("thin evidence (D3)", () => {
  it("leads with the thinness sentence when fewer than four records exist", () => {
    const story = buildStory({
      ...richStory,
      cause: null,
      promises: [],
      currentStatus: { known: false, value: null },
      statusChangedBy: { known: false, value: null },
      lastClientContact: { known: false, chases: null },
      latestFix: { known: false, text: null },
      openQuestion: null,
      recordCount: 2,
    });

    expect(story.tooThin).toBe(true);
    expect(story.sentences[0].text).toBe("Only 2 stored records back this account, so treat every statement as limited evidence.");
  });
});

describe("chronology (D2)", () => {
  const monthDay = (token: string): number | null => {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const match = token.match(/\b([A-Z][a-z]{2})\s+(\d{1,2})\b/);
    if (!match) return null;
    const month = months.indexOf(match[1].toLowerCase());
    if (month < 0) return null;
    return Date.UTC(2024, month, Number(match[2]));
  };

  it("orders any 'then' sentence by timestamp, second date no earlier than the first", () => {
    const stories = [
      richStory,
      { ...richStory, cause: { ...richStory.cause!, ts: "2024-09-24T03:00:00.000Z" } },
      { ...richStory, promises: [] },
    ];
    for (const input of stories) {
      for (const sentence of buildStory(input).sentences) {
        const segments = sentence.text.split(/\s+then\s+/i);
        if (segments.length < 2) continue;
        const dates = segments.map((segment) => segment.match(/\b[A-Z][a-z]{2}\s+\d{1,2}\b/)?.[0] ?? null);
        const parsed = dates
          .map((date) => (date ? monthDay(date) : null))
          .filter((value): value is number => value !== null);
        for (let index = 1; index < parsed.length; index += 1) {
          expect(parsed[index]).toBeGreaterThanOrEqual(parsed[index - 1]);
        }
      }
    }
  });
});

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

const demoShaped = (): ReportModelInput => {
  const events: Event[] = [
    event({ id: "e1", ts: "2024-09-10T03:00:00.000Z", text: "Issue created: Timezone totals wrong" }),
    event({
      id: "e2",
      ts: "2024-09-23T04:05:00.000Z",
      actor: "Marcus Webb",
      text: "Root cause looks like the MER-87 timezone change; the wrong totals come from it.",
    }),
    event({ id: "e3", ts: "2024-09-30T09:00:00.000Z", actor: "Marcus Webb", text: "Status: In Progress → Resolved" }),
    event({
      id: "e4",
      ts: "2024-10-02T09:00:00.000Z",
      source: "email",
      channel: "email",
      actor: "Priya Nair <priya@northwind.example>",
      text: "Totals are still wrong and nobody has replied.",
    }),
    event({
      id: "e5",
      ts: "2024-09-20T10:00:00.000Z",
      source: "email",
      channel: "email",
      actor: "Ravi Menon",
      text: "Ravi Menon committed the invoice totals fix to the Sep 24 release.",
    }),
  ];
  const claims: Claim[] = [
    claim({
      id: "c1",
      eventId: "e2",
      type: "root_cause",
      actor: "Marcus Webb",
      text: "The MER-87 timezone change introduced the wrong invoice totals.",
      quote: "Root cause looks like the MER-87 timezone change; the wrong totals come from it.",
      verifyStatus: "verified",
    }),
    claim({
      id: "c2",
      eventId: "e5",
      type: "commitment",
      actor: "Ravi Menon",
      text: "Ravi Menon committed the invoice totals fix to the Sep 24 release.",
      quote: "Ravi Menon committed the invoice totals fix to the Sep 24 release.",
      status: "broken",
      verifyStatus: "verified",
    }),
    claim({
      id: "c3",
      eventId: "e4",
      type: "process_failure",
      actor: "Priya Nair",
      text: "The client says totals are still wrong and nobody has replied.",
      quote: "Totals are still wrong and nobody has replied.",
      verifyStatus: "supported",
    }),
  ];
  const commitments: Commitment[] = [
    {
      id: "cm1",
      investigationId: "inv",
      claimId: "c2",
      promisor: "Ravi Menon",
      promisee: "Priya Nair",
      object: "the invoice totals fix",
      conditions: null,
      deadlinePhrase: "Sep 24",
      deadlineIso: "2024-09-24",
      rationale: null,
      fulfilmentEventIds: [],
      status: "broken",
      contested: false,
      sourceEventIds: ["e5"],
      dedupeKey: "k",
      createdAt: "2024-09-20T10:00:00.000Z",
    },
  ];
  const scope: InvestigationScope = {
    client: "Northwind Logistics",
    project: "Meridian",
    ticketPrefixes: ["MER"],
    channels: ["meridian-billing"],
    senderDomains: ["northwind.example"],
    confidence: "scoped",
    anchors: [{ kind: "declared-client", value: "Northwind Logistics", source: "declared" }],
  };
  return {
    investigation: {
      title: "MER-101: Issue created: Timezone totals wrong",
      escalationText: "Northwind reports totals are wrong since 4.12.",
      createdAt: "2024-09-10T03:00:00.000Z",
    },
    events,
    claims,
    commitments,
    gaps: [],
    notes: [],
    scope,
    clientDomains: ["northwind.example"],
    clientActors: [],
  };
};

describe("headline delegates to the story (D1-D3)", () => {
  it("answers the escalation without record-type metadata", () => {
    const model = buildReportModel(demoShaped());
    const text = model.headline.sentences.map((sentence) => sentence.text).join(" ");

    expect(text).toContain("timezone change");
    expect(text).toContain("Ravi Menon promised to Priya Nair: “the invoice totals fix” by Sep 24; it was broken.");
    expect(text).toContain("As of now: Resolved");
    expect(text).toContain("Still unknown:");
    expect(text).not.toContain("the first record is");
    expect(text).not.toContain("the latest record is");
    expect(model.headline.tooThin).toBe(false);
    expect(model.headline.nextStep).toBeTruthy();
    expect(model.headline.sentences.every((sentence) => sentence.findingIds.length > 0)).toBe(true);
  });
});
