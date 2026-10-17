import { describe, expect, it } from "vitest";

import { deriveDateWindow, parsePlanData, renderPlan } from "../lib/pipeline/plan";

describe("parsePlanData", () => {
  it("normalizes a valid structured plan", () => {
    const parsed = parsePlanData(
      JSON.stringify({
        framing: "Invoices drifted after the 4.12 release.",
        hypotheses: [
          {
            statement: "The 4.12 timezone change caused the invoice drift.",
            test: "Compare invoice totals before and after Sep 10.",
            falsify: "Totals unchanged across the deploy.",
          },
        ],
        sources: [
          { source: "jira", approach: "Read MER-201 and MER-202 fully." },
          { source: "slack", approach: "Search the billing channel around Sep 24." },
        ],
        searchTerms: ["invoice", "totals", "4.12"],
        people: ["Priya Nair", "Lin Chen"],
        dateWindow: { from: "2024-09-01", to: null },
        unknowns: ["Who approved the release?"],
      }),
    );

    expect(parsed?.framing).toBe("Invoices drifted after the 4.12 release.");
    expect(parsed?.hypotheses[0].falsify).toBe("Totals unchanged across the deploy.");
    expect(parsed?.sources).toHaveLength(2);
    expect(parsed?.searchTerms).toEqual(["invoice", "totals", "4.12"]);
    expect(parsed?.dateWindow).toEqual({ from: "2024-09-01", to: null });
  });

  it("rejects junk dates, empty shells and non-JSON content", () => {
    const junkDates = parsePlanData(
      JSON.stringify({
        framing: "Something.",
        dateWindow: { from: "sometime", to: "2024-09-24" },
      }),
    );
    expect(junkDates?.dateWindow).toEqual({ from: null, to: "2024-09-24" });

    expect(parsePlanData(JSON.stringify({ framing: "", hypotheses: [] }))).toBeNull();
    expect(parsePlanData("just prose, no JSON")).toBeNull();
  });

  it("caps oversized arrays and drops unusable entries", () => {
    const parsed = parsePlanData(
      JSON.stringify({
        framing: "x",
        hypotheses: Array.from({ length: 20 }, (_, index) => ({
          statement: `s${index}`,
          test: "t",
          falsify: "f",
        })),
        searchTerms: Array.from({ length: 50 }, (_, index) => `term${index}`),
        people: [42, "", "Priya"],
      }),
    );

    expect(parsed?.hypotheses.length).toBeLessThanOrEqual(6);
    expect(parsed?.searchTerms.length).toBeLessThanOrEqual(20);
    expect(parsed?.people).toEqual(["Priya"]);
  });
});

describe("renderPlan", () => {
  it("renders sections for the investigator prompt and skips empties", () => {
    const text = renderPlan({
      framing: "Framing text.",
      hypotheses: [{ statement: "S", test: "T", falsify: "G" }],
      sources: [{ source: "jira", approach: "Read the tickets." }],
      searchTerms: ["invoice"],
      people: ["Priya"],
      dateWindow: { from: "2024-09-01", to: null },
      unknowns: ["Who approved?"],
    });

    expect(text).toContain("Framing text.");
    expect(text).toContain("Hypotheses to test:");
    expect(text).toContain("- S — test: T; falsify: G");
    expect(text).toContain("- jira: Read the tickets.");
    expect(text).toContain("Seed terms: invoice");
    expect(text).toContain("People to look at: Priya");
    expect(text).toContain("Focus window: from 2024-09-01");
    expect(text).toContain("Unknowns to keep open:");
    expect(text).toContain("- Who approved?");
  });
});

describe("deriveDateWindow", () => {
  const reference = "2024-10-01T00:00:00.000Z";

  it("derives a start date from relative phrasing", () => {
    expect(deriveDateWindow("wrong for three weeks now", reference)).toEqual({
      from: "2024-09-10",
      to: null,
    });
    expect(deriveDateWindow("broken since 4 days ago", reference)).toEqual({
      from: "2024-09-27",
      to: null,
    });
    expect(deriveDateWindow("two months of pain", reference)).toEqual({
      from: "2024-08-02",
      to: null,
    });
  });

  it("returns nulls when no phrase is present", () => {
    expect(deriveDateWindow("totals are wrong", reference)).toEqual({ from: null, to: null });
  });
});
