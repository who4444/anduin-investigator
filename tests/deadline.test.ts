import { describe, expect, it } from "vitest";

import { extractDeadline } from "../lib/report/build";

/* G-04 date table: every case here once failed on the old token regex —
   bare months, "March" prefixes inside words, invented years. Keep them all
   green; each one is a real production failure class. */

const REF = "2024-09-10T03:00:00.000Z";

describe("extractDeadline (G-04 table)", () => {
  it("parses a full ISO date as the end of that day", () => {
    expect(extractDeadline("The fix will ship 2024-09-24.", REF)).toEqual({
      label: "2024-09-24",
      iso: "2024-09-24T23:59:59.000Z",
    });
  });

  it("resolves a month-day deadline against the reference record's year", () => {
    expect(extractDeadline("The fix will ship in the Sep 24 release.", REF)?.iso?.slice(0, 10)).toBe(
      "2024-09-24",
    );
  });

  it("parses a day-month deadline", () => {
    expect(extractDeadline("Promised by 15 Sep at the latest.", REF)?.iso?.slice(0, 10)).toBe(
      "2024-09-15",
    );
  });

  it("returns null when the text states no date", () => {
    expect(extractDeadline("The fix is coming soon.", REF)).toBeNull();
  });

  /* DATE_TOKEN currently splices the month alternation at the top level, so
     any bare "Mar".."Dec" token anywhere in prose matches as a deadline —
     the direct source of the real "185 days late in a 26-day incident"
     failures. This ratchet pins the fix. */
  it("does not invent a deadline from a bare month", () => {
    expect(extractDeadline("We will ship by the end of March.", REF)).toBeNull();
  });

  it("parses a full month name before the day", () => {
    const result = extractDeadline("The fix will ship March 15.", REF);
    expect(result?.label).toBe("March 15");
    expect(result?.iso?.slice(0, 10)).toBe("2024-03-15");
  });

  it("labels a day with the full month name, not the 'Mar' prefix", () => {
    expect(extractDeadline("We will ship by 15 March.", REF)?.label).toBe("15 March");
  });

  it("refuses to invent the current year when no reference exists", () => {
    expect(extractDeadline("We will ship in the Sep 24 release.", null)?.iso ?? null).toBeNull();
  });

  it("resolves a December promise about January to the next year", () => {
    const result = extractDeadline("We will ship on Jan 5.", "2024-12-20T10:00:00.000Z");
    expect(result?.iso?.slice(0, 10)).toBe("2025-01-05");
  });

  it("does not read a month prefix inside a word as a date", () => {
    expect(extractDeadline("Issue 3 Marching orders are done.", REF)).toBeNull();
  });
});
