import { describe, expect, it } from "vitest";

import { cleanGapText, rankGaps } from "../lib/report/gaps";
import type { Gap } from "../lib/types";

const gap = (over: Partial<Gap> & { id: string; question: string; note: string }): Gap => ({
  investigationId: "inv",
  eventIds: [],
  ...over,
});

describe("cleanGapText (G-11)", () => {
  it("strips internal record ids", () => {
    expect(cleanGapText("See e_verify_slack_1 for the note.")).not.toContain("e_verify_slack_1");
    expect(cleanGapText("Record 8d1a3d0e-1111-2222-3333-444455556666 says so.")).toBe(
      "Record a stored record says so.",
    );
  });

  it("rewrites first-person agent voice and keeps ticket keys", () => {
    expect(cleanGapText("I was unable to find MER-101 in the mailbox.")).toBe(
      "we could not find MER-101 in the mailbox.",
    );
    expect(cleanGapText("I could not determine who approved the release.")).toBe(
      "we could not determine who approved the release.",
    );
    expect(cleanGapText("Who approved MER-101?")).toBe("Who approved MER-101?");
    expect(cleanGapText("I searched all channels.")).toBe("we searched all channels.");
  });
});

describe("rankGaps (G-11)", () => {
  it("dedupes identical gaps and tags the rest", () => {
    const ranked = rankGaps([
      gap({ id: "g1", question: "Who approved the release?", note: "No record of approval exists." }),
      gap({ id: "g1b", question: "Who approved the release?", note: "No record of approval exists." }),
      gap({ id: "g2", question: "Was the client told?", note: "The email source was never searched." }),
      gap({ id: "g3", question: "Which build is current?", note: "Two records conflict on the build number." }),
      gap({ id: "g4", question: "What is the internal escalation date?", note: "Not documented anywhere we can see." }),
    ]);

    expect(ranked.map((entry) => entry.id)).not.toContain("g1b");
    expect(ranked.find((entry) => entry.id === "g2")?.tag).toBe("not-searched");
    expect(ranked.find((entry) => entry.id === "g3")?.tag).toBe("conflicting");
    expect(ranked.find((entry) => entry.id === "g1")?.tag).toBe("searched-absent");
    expect(ranked.find((entry) => entry.id === "g4")?.tag).toBe("open");
  });

  it("ranks client-facing, actionable gaps first", () => {
    const ranked = rankGaps([
      gap({ id: "internal", question: "Which internal tool logged the merge?", note: "No record of the tool." }),
      gap({ id: "client", question: "When will the client get the fix?", note: "The email source was never searched." }),
      gap({ id: "conflict-internal", question: "Which lane owned the merge?", note: "Two records conflict." }),
    ]);

    expect(ranked[0].id).toBe("client");
    expect(ranked[ranked.length - 1].id).toBe("internal");
  });

  it("boosts not-searched gaps the coverage report can back", () => {
    const coverage = {
      sources: [],
      neverSearched: ["email" as const],
    };
    const a = rankGaps(
      [gap({ id: "x", question: "Was the client told?", note: "The email source was never searched." })],
      coverage,
    );
    const b = rankGaps(
      [gap({ id: "x", question: "Was the client told?", note: "The email source was never searched." })],
      { sources: [], neverSearched: [] },
    );
    expect(a[0].rank).toBeGreaterThan(b[0].rank);
  });
});
