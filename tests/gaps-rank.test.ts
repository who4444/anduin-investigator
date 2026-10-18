import { describe, expect, it } from "vitest";

import { cleanGapText, rankGaps } from "../lib/report/gaps";
import type { Gap } from "../lib/types";

const gap = (over: Partial<Gap> & { id: string; question: string; note: string }): Gap => ({
  investigationId: "inv",
  eventIds: [],
  ...over,
});

describe("cleanGapText (G-11/C4)", () => {
  it("removes internal record ids without leaving a placeholder", () => {
    expect(cleanGapText("See e_verify_slack_1 for the note.")).not.toContain("e_verify_slack_1");
    expect(cleanGapText("See e_verify_slack_1 for the note.")).not.toContain("stored record");
    expect(cleanGapText("Record 8d1a3d0e-1111-2222-3333-444455556666 says so.")).toBe(
      "Record says so.",
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

  it("replaces tool calls with concrete source labels, never a generic lookup", () => {
    expect(cleanGapText("get_issue(SUP-2231) failed and the Jira angle was not searched.")).toBe(
      "the Jira search for SUP-2231 failed and the Jira angle was not searched.",
    );
    expect(cleanGapText("the get_slack_thread calls failed for both channels.")).toBe(
      "the Slack search calls failed for both channels.",
    );
    expect(cleanGapText("I was unable to search_email(support) for the reply.")).toBe(
      "the email search for support could not be completed for the reply.",
    );
    expect(cleanGapText("get_slack_thread(meridian-billing) and search_slack both FAILED.")).toBe(
      "the Slack search for meridian-billing and the Slack search both FAILED.",
    );
  });

  it("removes internal claim numbers without inventing a replacement", () => {
    const cleaned = cleanGapText(
      "The claim set substitutes Meridian (e.g., claims 26, 27, 39) for the client.",
    );
    expect(cleaned).not.toMatch(/claims?\s+\d/i);
    expect(cleaned).not.toContain("stored findings");
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

  it("recognises hyphenated never-searched and failed source lookups", () => {
    const ranked = rankGaps([
      gap({
        id: "never",
        question: "Never-searched angle: no query targeted the deployment date.",
        note: "The source lookup failed for the release channel.",
      }),
    ]);
    expect(ranked[0].tag).toBe("not-searched");
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

  it("drops gaps that reference raw records or internal claim numbers", () => {
    const ranked = rankGaps([
      gap({ id: "raw", question: "See e_58b4 for the details.", note: "" }),
      gap({
        id: "claims",
        question: "Which finding overstates the fix?",
        note: "Claim 4 (and 9, 26) overstates the fix.",
      }),
      gap({ id: "ok", question: "Who approved the release?", note: "" }),
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("collapses near-duplicate questions instead of listing 24 variants", () => {
    const ranked = rankGaps(
      Array.from({ length: 24 }, (_, index) =>
        gap({
          id: `dup_${index}`,
          question: `Did the client hear about the fix? (check ${index + 1})`,
          note: "No reply was recorded in the searched mail.",
          category: "communication",
        }),
      ),
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0].question).toBe("Did the client hear about the fix?");
  });

  it("promotes a generic umbrella question to the actual unknown", () => {
    const ranked = rankGaps([
      gap({
        id: "g1",
        question: "Could not determine (decisions and ownership)",
        note: "No build promotion record was found for the Sep 24 release.",
      }),
      gap({
        id: "g2",
        question: "Could not determine (decisions and ownership)",
        note: "No source shows who approved the hotfix deploy.",
      }),
    ]);

    expect(ranked).toHaveLength(2);
    expect(ranked.map((entry) => entry.question)).toEqual([
      "No build promotion record was found for the Sep 24 release.",
      "No source shows who approved the hotfix deploy.",
    ]);
    expect(ranked.every((entry) => entry.note === "")).toBe(true);
  });
});
