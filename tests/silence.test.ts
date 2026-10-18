import { describe, expect, it } from "vitest";

import { incidentRelevantEventIds } from "../lib/report/silence";
import type { Claim, Event, Gap, SkepticNote } from "../lib/types";

const event = (over: Partial<Event> & { id: string; ts: string; text: string }): Event => ({
  investigationId: "inv",
  source: "slack",
  actor: "Marcus Webb",
  channel: "meridian-billing",
  ...over,
});

describe("incident-relevant records (C5 core)", () => {
  it("cited, transitional, client and delivery records are relevant; chatter is not", () => {
    const events: Event[] = [
      event({ id: "e-cited", ts: "2024-09-10T03:00:00.000Z", text: "Timezone change merged for release 4.12." }),
      event({ id: "e-chatter", ts: "2024-09-11T03:00:00.000Z", text: "Coffee machine on floor 3 is fixed." }),
      event({ id: "e-status", ts: "2024-09-12T03:00:00.000Z", text: "Status: In Progress → Resolved" }),
      event({
        id: "e-client",
        ts: "2024-09-13T03:00:00.000Z",
        actor: "Priya Nair <priya.nair@northwind.example>",
        source: "email",
        channel: "email",
        text: "Totals are still wrong this morning.",
      }),
      event({ id: "e-fix", ts: "2024-09-14T03:00:00.000Z", text: "Release 5.3.4 shipped with the export fix." }),
    ];
    const claims: Claim[] = [{ id: "c1", eventId: "e-cited" } as Claim];
    const gaps: Gap[] = [{ id: "g1", eventIds: ["e-cited"] } as Gap];
    const notes: SkepticNote[] = [{ id: "n1", eventIds: ["e-fix"] } as SkepticNote];

    const relevant = incidentRelevantEventIds({ events, claims, commitments: [], gaps, notes });
    expect(relevant.has("e-cited")).toBe(true);
    expect(relevant.has("e-status")).toBe(true);
    expect(relevant.has("e-client")).toBe(true);
    expect(relevant.has("e-fix")).toBe(true);
    expect(relevant.has("e-chatter")).toBe(false);
  });
});

describe("one silence computation (C5)", () => {
  const DAY = 86_400_000;
  const iso = (day: number, hour = 10) => new Date(Date.parse("2024-09-01T00:00:00.000Z") + day * DAY + hour * 3_600_000).toISOString();

  function scenario() {
    const events: Event[] = [
      {
        id: "e-jira-1", investigationId: "inv", source: "jira", ts: iso(3), actor: "Lin Chen", channel: "MER-101",
        text: "Timezone change merged for release 4.12.",
      },
      // 13 quiet days inside Jira — the planted silence.
      {
        id: "e-jira-2", investigationId: "inv", source: "jira", ts: iso(16), actor: "Marcus Webb", channel: "MER-101",
        text: "Status: In Progress → Resolved",
      },
      {
        id: "e-slack-noise", investigationId: "inv", source: "slack", ts: iso(15), actor: "Marcus Webb", channel: "general",
        text: "Coffee machine on floor 3 is fixed.",
      },
      {
        id: "e-client-1", investigationId: "inv", source: "email", ts: iso(20), actor: "Priya Nair <priya.nair@northwind.example>", channel: "email",
        text: "Checking in - is the Sep 24 release out? We still see wrong totals.",
      },
      {
        id: "e-vendor-1", investigationId: "inv", source: "email", ts: iso(25), actor: "Marcus Webb <marcus.webb@meridian-software.example>", channel: "email",
        text: "Build is going out tonight; the invoice fix is included.",
      },
      {
        id: "e-client-2", investigationId: "inv", source: "email", ts: iso(30), actor: "Priya Nair <priya.nair@northwind.example>", channel: "email",
        text: "Still nothing. Escalating this on our side today.",
      },
    ];
    const claims: Claim[] = [
      { id: "c1", eventId: "e-jira-1", agent: "root_cause", type: "root_cause", text: "c", quote: "q", status: "n/a", confidence: 0.9, verifyStatus: "verified", skepticFlag: false },
      { id: "c2", eventId: "e-jira-2", agent: "root_cause", type: "ownership", text: "c", quote: "q", status: "n/a", confidence: 0.9, verifyStatus: "verified", skepticFlag: false },
      { id: "c3", eventId: "e-vendor-1", agent: "commitments", type: "commitment", text: "c", quote: "q", status: "broken", confidence: 0.9, verifyStatus: "verified", skepticFlag: false },
    ] as Claim[];
    return { events, claims };
  }

  it("computes the client wait and the project silence as distinct windows", async () => {
    const { computeSilences } = await import("../lib/report/silence");
    const { events, claims } = scenario();
    const silences = computeSilences({
      events,
      claims,
      clientEvidence: { domains: ["northwind.example"], actors: ["priya nair"], channels: [], threads: [], eventIds: [] },
    });
    // Client wait: the client's last message (day 30) has no vendor reply → ends at the horizon.
    expect(silences.clientWait).not.toBeNull();
    expect(silences.clientWait!.from.startsWith(iso(30).slice(0, 10))).toBe(true);
    // Project silence: the longest incident-relevant gap = the 13-day Jira quiet
    // (day 3 → day 16); the coffee machine on day 15 must not break it.
    expect(silences.project).not.toBeNull();
    expect(silences.project!.days).toBe(13);
    // The Jira per-source silence is the same window.
    expect(silences.bySource.jira).not.toBeNull();
    expect(silences.bySource.jira!.days).toBe(13);
    // The headline prefers the client wait when a client is waiting.
    expect(silences.headline?.kind).toBe("clientWait");
  });

  it("labels the window 'no incident activity', never 'no recorded activity'", async () => {
    const { computeSilences } = await import("../lib/report/silence");
    const { events, claims } = scenario();
    const silences = computeSilences({ events, claims });
    expect(silences.project!.label).toMatch(/no incident activity/i);
    expect(silences.project!.label).not.toMatch(/no recorded activity/i);
  });
});
