import { describe, expect, it } from "vitest";

import { buildVocabularyDigest, renderVocabularyDigest } from "../lib/pipeline/vocabulary";
import type { Event } from "../lib/types";

const event = (over: Partial<Event> & { id: string }): Event => ({
  investigationId: "inv",
  source: "jira",
  ts: "2024-09-10T03:00:00.000Z",
  actor: "Lin Chen",
  channel: "MER-201",
  text: "text",
  ...over,
});

describe("buildVocabularyDigest", () => {
  it("extracts tickets, versions, channels, domains and frequent terms", () => {
    const events = [
      event({
        id: "a",
        channel: "MER-201",
        text: "The timezone change in release 4.12 broke invoice totals. See MER-202.",
        refs: ["MER-202"],
      }),
      event({
        id: "b",
        source: "slack",
        channel: "meridian-billing",
        text: "Invoice totals still wrong after 4.12. Patch 1.0.3 did not help.",
      }),
      event({
        id: "c",
        source: "email",
        actor: "Priya <priya@northwind.example>",
        channel: "email",
        text: "Invoice totals remain incorrect.",
      }),
    ];

    const digest = buildVocabularyDigest(events);

    expect(digest.tickets).toEqual(["MER-201", "MER-202"]);
    expect(digest.versions).toEqual(["1.0.3", "4.12"]);
    expect(digest.channels).toEqual(["meridian-billing"]);
    expect(digest.domains).toEqual(["northwind.example"]);
    expect(digest.terms).toContain("invoice");
    expect(digest.terms).toContain("totals");
    expect(digest.terms).not.toContain("the");
  });

  it("ignores clock times, epoch numbers and IP addresses when reading versions", () => {
    const digest = buildVocabularyDigest([
      event({ id: "a", text: "Rollout at 09:30:00 on 1727251200 from 192.168.0.1 with build 2.0." }),
    ]);
    expect(digest.versions).toEqual(["2.0"]);
  });

  it("reads a v-prefixed build tag", () => {
    const digest = buildVocabularyDigest([
      event({ id: "a", text: "Shipped as v4.12 yesterday." }),
    ]);
    expect(digest.versions).toEqual(["4.12"]);
  });

  it("counts document frequency, not raw repetitions", () => {
    const repetitive = event({ id: "a", text: "invoice invoice invoice invoice invoice" });
    const normal = event({ id: "b", text: "invoice totals drifted" });
    const other = event({ id: "c", text: "quiet day" });
    const digest = buildVocabularyDigest([repetitive, normal, other]);
    // "invoice" appears in two documents, "totals" in one — the repetition
    // inside a single record must not dominate the seed terms.
    expect(digest.terms.indexOf("invoice")).toBeLessThan(digest.terms.indexOf("totals"));
  });

  it("returns empty lists for an empty store", () => {
    expect(buildVocabularyDigest([])).toEqual({
      tickets: [],
      versions: [],
      channels: [],
      domains: [],
      terms: [],
    });
  });

  it("caps list sizes", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      event({ id: `e${index}`, channel: `MER-${100 + index}` }),
    );
    expect(buildVocabularyDigest(many).tickets.length).toBeLessThanOrEqual(40);
  });
});

describe("renderVocabularyDigest", () => {
  it("renders a prompt-ready block and skips empty sections", () => {
    const text = renderVocabularyDigest({
      tickets: ["MER-201"],
      versions: ["4.12"],
      channels: [],
      domains: [],
      terms: ["invoice", "totals"],
    });
    expect(text).toContain("Tickets: MER-201");
    expect(text).toContain("Versions/builds: 4.12");
    expect(text).toContain("Frequent terms: invoice, totals");
    expect(text).not.toContain("Channels:");
  });

  it("returns an empty string for an empty digest", () => {
    expect(
      renderVocabularyDigest({ tickets: [], versions: [], channels: [], domains: [], terms: [] }),
    ).toBe("");
  });
});
