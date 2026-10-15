import { describe, expect, it } from "vitest";

import { findQuoteRange, highlightSegments } from "../lib/highlight";

describe("findQuoteRange", () => {
  it("finds an exact substring", () => {
    expect(findQuoteRange("hello world", "world")).toEqual({ start: 6, end: 11 });
  });

  it("finds a quote that differs only in whitespace", () => {
    const text = "QA still\nfailing   on the Sep 24 build";
    const range = findQuoteRange(text, "still failing on the Sep 24");
    expect(text.slice(range!.start, range!.end)).toBe("still\nfailing   on the Sep 24");
  });

  it("returns null when the quote is not present", () => {
    expect(findQuoteRange("hello world", "goodbye")).toBeNull();
  });

  it("returns null for an empty or whitespace-only quote", () => {
    expect(findQuoteRange("hello", "")).toBeNull();
    expect(findQuoteRange("hello", "   ")).toBeNull();
  });

  it("does not match when wording differs", () => {
    expect(findQuoteRange("the fix shipped", "the fix was shipped")).toBeNull();
  });
});

describe("highlightSegments", () => {
  it("marks the quoted span and leaves the rest plain", () => {
    const segments = highlightSegments("prefix the fix shipped suffix", ["the fix shipped"]);

    expect(segments).toEqual([
      { text: "prefix ", highlighted: false },
      { text: "the fix shipped", highlighted: true },
      { text: " suffix", highlighted: false },
    ]);
  });

  it("ignores quotes that are not found", () => {
    const segments = highlightSegments("the fix shipped", ["something else"]);
    expect(segments).toEqual([{ text: "the fix shipped", highlighted: false }]);
  });

  it("merges overlapping quotes without duplicating text", () => {
    const segments = highlightSegments("the fix shipped today", ["the fix", "fix shipped"]);
    const joined = segments.map((segment) => segment.text).join("");
    expect(joined).toBe("the fix shipped today");
    expect(segments.filter((segment) => segment.highlighted).map((segment) => segment.text)).toEqual([
      "the fix shipped",
    ]);
  });

  it("handles a quote at the very start and end", () => {
    const segments = highlightSegments("fix shipped today", ["fix shipped", "today"]);
    expect(segments.map((segment) => segment.text).join("")).toBe("fix shipped today");
    expect(segments.filter((segment) => segment.highlighted).map((segment) => segment.text)).toEqual([
      "fix shipped",
      "today",
    ]);
  });
});
