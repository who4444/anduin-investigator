import { describe, expect, it } from "vitest";

import { extractTicketRefs } from "../lib/ingest/refs";

describe("extractTicketRefs", () => {
  it("finds uppercase ticket keys", () => {
    expect(extractTicketRefs("See SUP-2231 and ABC-12 for context.")).toEqual(["SUP-2231", "ABC-12"]);
  });

  it("matches case-insensitively but outputs uppercase", () => {
    expect(extractTicketRefs("linked to sup-2231")).toEqual(["SUP-2231"]);
  });

  it("dedupes repeated refs, preserving first-appearance order", () => {
    expect(extractTicketRefs("SUP-2231 ... ABC-12 ... SUP-2231")).toEqual(["SUP-2231", "ABC-12"]);
  });

  it("ignores a key with no numeric suffix", () => {
    expect(extractTicketRefs("FOO- is not a ticket")).toEqual([]);
  });

  it("returns an empty array when there are no refs", () => {
    expect(extractTicketRefs("nothing to see here")).toEqual([]);
  });
});
