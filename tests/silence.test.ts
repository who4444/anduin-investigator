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
