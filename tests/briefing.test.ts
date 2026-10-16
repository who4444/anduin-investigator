import { describe, expect, it } from "vitest";

import { buildBriefing } from "../lib/report/briefing";
import type { Claim, Event } from "../lib/types";

const event = (over: Partial<Event> & { id: string; ts: string }): Event => ({
  investigationId: "inv",
  source: "jira",
  actor: "Ravi Menon",
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
  event({ id: "e2", ts: "2024-09-23T04:00:00.000Z", actor: "Marcus Webb", text: "Root cause linked to MER-87." }),
  event({
    id: "e3",
    ts: "2024-09-24T16:00:00.000Z",
    actor: "Marcus Webb",
    source: "slack",
    channel: "seed1-client",
    text: "The fix ships in the Sep 24 release.",
  }),
  event({
    id: "e4",
    ts: "2024-09-25T09:00:00.000Z",
    actor: "Dana Okoro",
    source: "slack",
    channel: "seed1-ops",
    text: "QA is still failing on the Sep 24 build.",
  }),
  event({
    id: "e5",
    ts: "2024-10-08T09:00:00.000Z",
    actor: "Noah Bright",
    source: "slack",
    channel: "seed1-eng",
    text: "Nobody picked up the on-call rota; she is on leave with no handoff.",
  }),
];

const claims: Claim[] = [
  claim({ id: "c1", eventId: "e1", text: "The 4.12 timezone change introduced the defect.", type: "root_cause", ts: "2024-09-10T03:00:00.000Z" }),
  claim({ id: "c2", eventId: "e2", text: "The root cause was linked to MER-87.", type: "root_cause", ts: "2024-09-23T04:00:00.000Z" }),
  claim({
    id: "c3",
    eventId: "e3",
    text: "Marcus Webb promised the fix in the Sep 24 release.",
    type: "commitment",
    status: "broken",
    actor: "Marcus Webb",
    ts: "2024-09-24T16:00:00.000Z",
  }),
  claim({
    id: "c4",
    eventId: "e5",
    text: "The owner went on leave with no handoff and nobody picked up the rota.",
    type: "ownership",
    actor: "Noah Bright",
    status: "n/a",
    ts: "2024-10-08T09:00:00.000Z",
  }),
  claim({
    id: "c5",
    eventId: "e4",
    text: "A minor observation with low confidence.",
    type: "decision",
    confidence: 0.3,
    ts: "2024-09-25T09:00:00.000Z",
  }),
];

describe("buildBriefing", () => {
  const briefing = buildBriefing({ events, claims });

  it("composes a factual narrative and reports confidence", () => {
    expect(briefing.narrative).toContain("source-backed findings");
    expect(briefing.narrative).toContain("promises read as broken");
    expect(briefing.confidence).toEqual({ verified: 5, supported: 0, rejected: 0, total: 5, flagged: 0 });
  });

  it("produces chapters split at long silences, with takeaways", () => {
    expect(briefing.chapters.length).toBeGreaterThanOrEqual(2);
    for (const chapter of briefing.chapters) {
      expect(chapter.title.length).toBeGreaterThan(0);
      expect(chapter.takeaway).toMatch(/findings/);
      expect(chapter.eventIds.length).toBeGreaterThan(0);
    }
    const withBroken = briefing.chapters.find((chapter) =>
      chapter.eventIds.includes("ev_c3"),
    );
    expect(withBroken?.takeaway).toMatch(/broken promise/);
  });

  it("cuts chapters at silences even when a claim carries its own timestamp", () => {
    const shifted = claims.map((entry) =>
      entry.id === "c5" ? { ...entry, ts: "2024-09-25" } : entry,
    );
    const shiftedBriefing = buildBriefing({ events, claims: shifted });
    expect(shiftedBriefing.chapters.length).toBeGreaterThanOrEqual(2);
    // The Sep 25 → Oct 8 silence must separate the Sep 25 finding from the
    // Oct 8 finding even though c5's claim ts is date-only.
    const chapterOf = (claimId: string) =>
      shiftedBriefing.chapters.findIndex((chapter) => chapter.eventIds.includes(`ev_${claimId}`));
    const c5Chapter = chapterOf("c5");
    expect(c5Chapter).toBeGreaterThanOrEqual(0);
    expect(chapterOf("c4")).not.toBe(c5Chapter);
  });

  it("assigns importance, lanes and headlines", () => {
    const brokenPromise = briefing.events.find((entry) => entry.claimId === "c3");
    expect(brokenPromise).toMatchObject({ importance: "key", lane: "promises", actorRole: "client" });
    expect(brokenPromise?.headline.split(" ").length).toBeLessThanOrEqual(10);

    const leave = briefing.events.find((entry) => entry.claimId === "c4");
    expect(leave).toMatchObject({ importance: "key", lane: "owner" });

    const routine = briefing.events.find((entry) => entry.claimId === "c5");
    expect(routine?.importance).toBe("routine");

    const jira = briefing.events.find((entry) => entry.claimId === "c1");
    expect(jira?.lane).toBe("ticket");
  });

  it("selects key moments with tags and a cap of five", () => {
    expect(briefing.keyMoments.length).toBeGreaterThan(0);
    expect(briefing.keyMoments.length).toBeLessThanOrEqual(5);
    expect(briefing.keyMoments[0].claimId).toBe("c3");
    expect(briefing.keyMoments[0].tag).toBe("process");
    expect(briefing.keyMoments.some((moment) => moment.tag === "technical")).toBe(true);
  });

  it("gives every person a stable palette color and role", () => {
    const names = briefing.people.map((person) => person.name);
    expect(names).toContain("Marcus Webb");
    const colors = briefing.people.map((person) => person.colorIndex);
    expect(new Set(colors).size).toBe(colors.length);
    expect(briefing.people.find((person) => person.name === "Marcus Webb")?.role).toBe("client");
    expect(briefing.people.find((person) => person.name === "Noah Bright")?.role).toBe("team");
  });

  it("labels silences with the sources that were actually quiet", () => {
    const early = briefing.silences.find((silence) => silence.from.startsWith("2024-09-10"));
    // jira's own record (e2) ends this silence, so jira was not quiet — only email and slack were.
    expect(early?.quietSources).toEqual(["email", "slack"]);
    const late = briefing.silences.find((silence) => silence.from.startsWith("2024-09-25"));
    // slack speaks at both ends of this one (e4 then e5), so jira and email went quiet.
    expect(late?.quietSources).toEqual(["jira", "email"]);
    const leaveSilence = briefing.silences.find((silence) => silence.leaveNote);
    expect(leaveSilence?.label).toContain("Owner on leave");
  });

  it("keeps the narrative factual when breaking promises exist", () => {
    const fallback = buildBriefing({ events, claims });
    expect(fallback.narrative).toContain("1 of 1 promises read as broken");
  });

  it("does not count unclear promises as kept in the narrative", () => {
    const withUnclear = [
      ...claims,
      claim({
        id: "c7",
        eventId: "e3",
        type: "commitment",
        status: "unclear",
        text: "A second promise whose outcome is unclear.",
        actor: "Marcus Webb",
        ts: "2024-09-24T17:00:00.000Z",
      }),
    ];
    const unclearBriefing = buildBriefing({ events, claims: withUnclear });
    expect(unclearBriefing.narrative).toMatch(/1 as unclear/);
    expect(unclearBriefing.narrative).not.toMatch(/1 as kept/);
  });

  it("never claims all promises are kept when outcomes are unclear", () => {
    const onlyUnclear = [
      claim({
        id: "c8",
        eventId: "e3",
        type: "commitment",
        status: "unclear",
        text: "Delivery date was suggested but never confirmed.",
        actor: "Marcus Webb",
        ts: "2024-09-24T17:00:00.000Z",
      }),
    ];
    const unclearBriefing = buildBriefing({ events, claims: onlyUnclear });
    expect(unclearBriefing.narrative).toMatch(/unclear/);
    expect(unclearBriefing.narrative).not.toMatch(/read as kept/);
  });

  it("renders an honest empty briefing when nothing was verified", () => {
    const empty = buildBriefing({ events: [], claims: [] });
    expect(empty.events).toEqual([]);
    expect(empty.chapters).toEqual([]);
    expect(empty.keyMoments).toEqual([]);
    expect(empty.people).toEqual([]);
  });
});
