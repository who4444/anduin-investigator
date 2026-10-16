import { describe, expect, it } from "vitest";

import { toUtcIso } from "../lib/ingest/normalize";

describe("toUtcIso", () => {
  it("keeps ISO timestamps with explicit offsets (Z or ±HH:MM / ±HHMM)", () => {
    expect(toUtcIso("2024-09-10T08:15:00Z")).toBe("2024-09-10T08:15:00.000Z");
    expect(toUtcIso("2024-09-10T08:15:00+02:00")).toBe("2024-09-10T06:15:00.000Z");
    expect(toUtcIso("2024-09-10T08:15:00.000+0000")).toBe("2024-09-10T08:15:00.000Z");
  });

  it("parses RFC2822 email dates with numeric or named zones", () => {
    expect(toUtcIso("Tue, 24 Sep 2024 09:30:00 +0800")).toBe("2024-09-24T01:30:00.000Z");
    expect(toUtcIso("Tue, 24 Sep 2024 09:30:00 GMT")).toBe("2024-09-24T09:30:00.000Z");
  });

  it("reads date-only strings as UTC midnight", () => {
    expect(toUtcIso("2024-09-24")).toBe("2024-09-24T00:00:00.000Z");
  });

  it("rejects offset-less naive timestamps instead of guessing the host zone", () => {
    expect(toUtcIso("2024-09-10T03:00:00")).toBe("");
    expect(toUtcIso("2024-09-10 14:30:00")).toBe("");
    expect(toUtcIso("Sep 24, 2024 9:00 AM")).toBe("");
  });

  it("rejects impossible dates and garbage rather than rolling over", () => {
    expect(toUtcIso("2024-02-30")).toBe("");
    expect(toUtcIso("not a date")).toBe("");
    expect(toUtcIso("")).toBe("");
  });
});
