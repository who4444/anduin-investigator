import { describe, expect, it } from "vitest";

import { buildDemoFiles } from "../scripts/gen-demo";
import { detectFile, expandArchives, type IngestFile } from "../lib/ingest/detect";
import { parseEml, parseMbox } from "../lib/ingest/email";
import { parseJira } from "../lib/ingest/jira";
import { parseSlackFiles, type SlackFile } from "../lib/ingest/slack";
import { dedupeEvents, capText, eventId, toUtcIso } from "../lib/ingest/normalize";
import { extractTicketRefs } from "../lib/ingest/refs";
import type { EventInput } from "../lib/types";

const encoder = new TextEncoder();

async function ingestDemo(): Promise<EventInput[]> {
  const files: IngestFile[] = buildDemoFiles().map((file) => ({
    name: file.name,
    bytes: encoder.encode(file.content),
  }));

  const events: EventInput[] = [];
  const slack: SlackFile[] = [];

  for (const file of expandArchives(files)) {
    const { kind, json } = detectFile(file);
    if (kind === "jira") {
      events.push(...parseJira(json).events);
    } else if (kind === "email-mbox") {
      events.push(...(await parseMbox(file.bytes)).events);
    } else if (kind === "email-eml") {
      events.push(...(await parseEml(file.bytes)).events);
    } else if (kind.startsWith("slack-")) {
      slack.push({ name: file.name, json });
    }
  }

  events.push(...parseSlackFiles(slack).events);

  return dedupeEvents(
    events.map((event) => ({
      ...event,
      ts: toUtcIso(event.ts),
      text: capText(event.text),
      refs: [...(event.refs ?? []), ...extractTicketRefs(event.text)],
    })),
  );
}

describe("demo scenario round-trip", () => {
  it("parses every generated export without throwing", async () => {
    const events = await ingestDemo();
    expect(events.length).toBeGreaterThanOrEqual(35);
    expect(events.length).toBeLessThanOrEqual(60);
  });

  it("covers all three sources with mixed timestamp formats normalised to UTC", async () => {
    const events = await ingestDemo();
    const sources = new Set(events.map((event) => event.source));
    expect(sources).toEqual(new Set(["jira", "email", "slack"]));

    for (const event of events) {
      expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
      expect(event.ts.endsWith("Z")).toBe(true);
    }
  });

  it("plants the identity, reference and silence traps", async () => {
    const events = await ingestDemo();

    const actors = new Set(events.map((event) => event.actor));
    expect([...actors].some((actor) => actor.includes("l.chen@northwind.example"))).toBe(true);
    expect(actors.has("Lin Chen")).toBe(true);

    const refs = new Set(events.flatMap((event) => event.refs ?? []));
    expect(refs.has("MER-101")).toBe(true);
    expect(refs.has("SUP-2231")).toBe(true);

    const jiraTimes = events
      .filter((event) => event.source === "jira")
      .map((event) => Date.parse(event.ts))
      .sort((a, b) => a - b);
    const maxGapDays = jiraTimes
      .slice(1)
      .reduce((max, time, index) => Math.max(max, (time - jiraTimes[index]) / 86_400_000), 0);
    expect(maxGapDays).toBeGreaterThanOrEqual(12);

    const identified = events.map((event) => eventId(event.source, event.ts, event.actor, event.channel, event.text));
    expect(new Set(identified).size).toBe(identified.length);
  });

  it("leads to a run where the premature resolution contradicts Slack", async () => {
    const events = await ingestDemo();
    const resolved = events.find(
      (event) => event.channel === "MER-101" && /resolved/i.test(event.text),
    );
    const qaStillFailing = events.find((event) => /QA is still failing/i.test(event.text));

    expect(resolved).toBeDefined();
    expect(qaStillFailing).toBeDefined();
    expect(Date.parse(qaStillFailing!.ts)).toBeLessThan(Date.parse(resolved!.ts));
  });
});
