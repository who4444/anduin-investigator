import { describe, expect, it } from "vitest";

import { normalizeWhitespace, verifyQuote } from "../lib/verify";

describe("normalizeWhitespace", () => {
  it("collapses runs of whitespace to a single space and trims", () => {
    expect(normalizeWhitespace("  a   b\tc\n\nd  ")).toBe("a b c d");
  });

  it("does not case-fold", () => {
    expect(normalizeWhitespace("  MiXeD Case  ")).toBe("MiXeD Case");
  });
});

describe("verifyQuote", () => {
  it("accepts an exact substring", () => {
    expect(verifyQuote("Ticket opened for the client", "Ticket opened")).toEqual({ ok: true });
  });

  it("matches a single-line quote against multi-line event text", () => {
    const eventText = "Ticket opened\nfor the client\non Monday";
    expect(verifyQuote(eventText, "opened for the client on Monday")).toEqual({ ok: true });
  });

  it("accepts a quote that has doubled spaces", () => {
    expect(verifyQuote("Ticket opened for the client", "opened  for  the")).toEqual({ ok: true });
  });

  it("accepts a quote with leading and trailing whitespace", () => {
    expect(verifyQuote("Ticket opened for the client", "  opened for the client  ")).toEqual({ ok: true });
  });

  it("rejects a quote with a changed word", () => {
    expect(verifyQuote("Ticket opened for the client", "Ticket closed for the client")).toEqual({
      ok: false,
      error: "quote_not_found",
    });
  });

  it("rejects a quote with changed case", () => {
    expect(verifyQuote("Ticket opened for the client", "Ticket Opened")).toEqual({
      ok: false,
      error: "quote_not_found",
    });
  });

  it("rejects an empty quote", () => {
    expect(verifyQuote("Ticket opened for the client", "")).toEqual({
      ok: false,
      error: "quote_not_found",
    });
    expect(verifyQuote("Ticket opened for the client", "   \n\t ")).toEqual({
      ok: false,
      error: "quote_not_found",
    });
  });

  it("rejects a curly quote against straight quotes", () => {
    const eventText = 'He said "we will fix it" in the call';
    expect(verifyQuote(eventText, "“we will fix it”")).toEqual({
      ok: false,
      error: "quote_not_found",
    });
  });
});
