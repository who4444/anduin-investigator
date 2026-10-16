import { describe, expect, it } from "vitest";

import { checkAttribution } from "../lib/pipeline/attribution";

const now = "2024-09-20T10:00:00.000Z";

describe("checkAttribution actor matching", () => {
  it("accepts an exact actor match", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: now },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts an email form against the plain name", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta <ravi@meridian.example>", ts: now },
      { actor: "ravi@meridian.example", ts: now },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a slack handle against a display name", () => {
    const result = checkAttribution(
      { actor: "Ravi M.", ts: now },
      { actor: "ravi_m", ts: now },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a claim written against the resolved canonical name", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: now },
      { actor: "ravi_m", actorResolved: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(true);
  });

  it("uses the identity alias map when neither side is canonical", () => {
    const aliasMap = new Map([["ravi_m", "Ravi Mehta"]]);
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: now },
      { actor: "ravi_m", ts: now },
      aliasMap,
    );
    expect(result.ok).toBe(true);
  });

  it("flags a different person as actor_mismatch", () => {
    const result = checkAttribution(
      { actor: "Dana Lee", ts: now },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("actor_mismatch");
    expect(result.detail.claimActor).toBe("Dana Lee");
    expect(result.detail.eventActor).toBe("Ravi Mehta");
  });

  it("flags a missing claim actor as a mismatch", () => {
    const result = checkAttribution({ ts: now }, { actor: "Ravi Mehta", ts: now });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("actor_mismatch");
  });

  it("does not match different full names that share a first name", () => {
    const result = checkAttribution(
      { actor: "Ravi Shah", ts: now },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(false);
  });
});

describe("checkAttribution timestamp matching", () => {
  it("accepts the exact event timestamp", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: now },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a timestamp within 60 seconds", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: "2024-09-20T10:00:59.000Z" },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(true);
  });

  it("flags a timestamp more than 60 seconds off as ts_mismatch", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: "2024-09-20T10:02:00.000Z" },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ts_mismatch");
  });

  it("accepts a date-only claim timestamp on the event's UTC date", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: "2024-09-20" },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(true);
  });

  it("flags a date-only claim timestamp on another day", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: "2024-09-19" },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ts_mismatch");
  });

  it("treats a missing claim timestamp as nothing to check", () => {
    const result = checkAttribution({ actor: "Ravi Mehta" }, { actor: "Ravi Mehta", ts: now });
    expect(result.ok).toBe(true);
  });

  it("flags an unparseable timestamp as invalid_ts", () => {
    const result = checkAttribution(
      { actor: "Ravi Mehta", ts: "sometime yesterday" },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_ts");
  });

  it("checks the actor first so a wrong person reports actor_mismatch", () => {
    const result = checkAttribution(
      { actor: "Dana Lee", ts: "2024-09-01T00:00:00.000Z" },
      { actor: "Ravi Mehta", ts: now },
    );
    expect(result.reason).toBe("actor_mismatch");
  });
});
