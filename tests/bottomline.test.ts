import { describe, expect, it } from "vitest";

import { buildBottomLine } from "../lib/report/bottomline";
import type { Claim, Event, Gap, SkepticNote } from "../lib/types";

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

const gap = (over: Partial<Gap> & { id: string }): Gap => ({
  investigationId: "inv",
  question: "An open question.",
  note: "A note.",
  eventIds: [],
  ...over,
});

describe("buildBottomLine", () => {
  it("summarises the five business answers from verified findings", () => {
    const events: Event[] = [
      event({ id: "e1", ts: "2024-09-10T03:00:00.000Z", text: "Timezone change merged for release 4.12." }),
      event({ id: "e6", ts: "2024-09-27T03:05:00.000Z", source: "email", actor: "Priya Nair", channel: "email", text: "Totals are still wrong." }),
      event({ id: "e7", ts: "2024-09-30T03:05:00.000Z", source: "email", actor: "Priya Nair", channel: "email", text: "Escalating on our side." }),
    ];
    const claims: Claim[] = [
      claim({ id: "c1", eventId: "e1", text: "The 4.12 timezone change introduced the invoice defect." }),
      claim({
        id: "c2",
        eventId: "e1",
        type: "commitment",
        status: "broken",
        text: "The fix was promised for the Sep 24 release and never shipped.",
      }),
      claim({ id: "c5", eventId: "e6", type: "process_failure", text: "The client chased with no reply." }),
    ];
    const gaps: Gap[] = [gap({ id: "g1", question: "Who approved the 4.12 release?" })];

    const bottom = buildBottomLine({
      events,
      claims,
      notes: [] as SkepticNote[],
      gaps,
      // The report passes the scope's client evidence (B5).
      clientActors: ["priya nair"],
    });
    const byId = new Map(bottom.cells.map((cell) => [cell.id, cell]));

    expect(byId.get("cause")).toMatchObject({ determined: true, tone: "neutral" });
    expect(byId.get("cause")?.claimIds).toContain("c1");
    expect(byId.get("cause")?.value).toContain("timezone change");
    expect(byId.get("promises")).toMatchObject({ determined: true, value: "1 of 1 broken", tone: "bad" });
    expect(byId.get("promises")?.claimIds).toContain("c2");
    expect(byId.get("chasers")).toMatchObject({ determined: true, tone: "bad" });
    expect(byId.get("chasers")?.eventIds).toEqual(["e6", "e7"]);
    expect(byId.get("silence")).toMatchObject({ determined: true, tone: "warn" });
    expect(byId.get("questions")).toMatchObject({ determined: true, value: "1 open", tone: "warn" });
  });

  it("reads all clear when promises were kept and nothing was chased", () => {
    const events: Event[] = [
      event({ id: "e1", ts: "2024-09-10T03:00:00.000Z", text: "Ticket opened." }),
      event({ id: "e2", ts: "2024-09-12T03:00:00.000Z", source: "email", actor: "Dana Okafor", channel: "email", text: "Fixed and verified." }),
    ];
    const claims: Claim[] = [
      claim({
        id: "c1",
        eventId: "e2",
        type: "commitment",
        status: "kept",
        text: "The fix shipped in the next release as promised.",
      }),
    ];

    const bottom = buildBottomLine({ events, claims, notes: [], gaps: [] });
    const byId = new Map(bottom.cells.map((cell) => [cell.id, cell]));

    expect(byId.get("promises")).toMatchObject({ value: "1 of 1 kept", tone: "good" });
    expect(byId.get("chasers")).toMatchObject({ determined: false, tone: "neutral" });
    expect(byId.get("questions")).toMatchObject({ value: "none open", tone: "neutral" });
  });

  it("stays neutral and honest on thin data", () => {
    const bottom = buildBottomLine({ events: [], claims: [], notes: [], gaps: [] });

    expect(bottom.cells.every((cell) => !cell.determined)).toBe(true);
    const byId = new Map(bottom.cells.map((cell) => [cell.id, cell]));
    expect(byId.get("cause")?.value).toBe("not determined");
    expect(byId.get("promises")?.value).toBe("no promises found");
    expect(byId.get("chasers")?.value).toBe("not determined (client unresolved)");
    expect(byId.get("silence")?.value).toBe("not determined");
    expect(byId.get("questions")?.value).toBe("none open");
  });

  it("prefers an unflagged root cause and warns when only a flagged one exists", () => {
    const events: Event[] = [
      event({ id: "e1", ts: "2024-09-10T03:00:00.000Z", text: "Timezone change merged." }),
      event({ id: "e2", ts: "2024-09-11T03:00:00.000Z", text: "Fix attempted." }),
    ];
    const flagged = claim({
      id: "c-flagged",
      eventId: "e1",
      text: "The earliest suspected cause is wrong.",
      skepticFlag: true,
    });
    const clean = claim({ id: "c-clean", eventId: "e2", text: "The verified cause is the timezone change." });

    const withBoth = buildBottomLine({ events, claims: [flagged, clean], notes: [], gaps: [] });
    const causeBoth = withBoth.cells.find((cell) => cell.id === "cause");
    expect(causeBoth).toMatchObject({ tone: "neutral" });
    expect(causeBoth?.claimIds[0]).toBe("c-clean");

    const flaggedOnly = buildBottomLine({ events, claims: [flagged], notes: [], gaps: [] });
    const causeFlagged = flaggedOnly.cells.find((cell) => cell.id === "cause");
    expect(causeFlagged).toMatchObject({ tone: "warn" });
    expect(causeFlagged?.detail).toContain("flagged in skeptic review");
  });

  it("counts unclear promises without calling them broken or kept", () => {
    const events: Event[] = [event({ id: "e1", ts: "2024-09-10T03:00:00.000Z", text: "Maybe we ship next week." })];
    const claims: Claim[] = [
      claim({
        id: "c1",
        eventId: "e1",
        type: "commitment",
        status: "unclear",
        text: "A fix date was suggested but never confirmed.",
      }),
    ];

    const bottom = buildBottomLine({ events, claims, notes: [], gaps: [] });
    const promises = bottom.cells.find((cell) => cell.id === "promises");

    expect(promises).toMatchObject({ value: "outcome unclear", tone: "warn" });
  });

  it("keeps the open-questions detail short", () => {
    const gaps: Gap[] = [
      gap({
        id: "g1",
        question:
          "Who approved the release decision and why was the client not told about the failed QA sign-off before it shipped",
      }),
    ];

    const bottom = buildBottomLine({ events: [], claims: [], notes: [], gaps });
    const questions = bottom.cells.find((cell) => cell.id === "questions");

    expect(questions?.detail).toContain("…");
    expect(questions?.detail?.length).toBeLessThan(140);
  });
});
