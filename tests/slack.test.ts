import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseSlackFiles } from "../lib/ingest/slack";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

const users = fixture("slack-users.json");
const channel = fixture("slack-channel.json");

function files(withUsers: boolean) {
  const list = withUsers ? [{ name: "users.json", json: users }] : [];
  return [...list, { name: "meridian-billing.json", json: channel }];
}

describe("parseSlackFiles", () => {
  it("resolves user ids to real names and converts epoch ts to exact ISO", () => {
    const { events } = parseSlackFiles(files(true));
    expect(events).toHaveLength(5);
    expect(events[0].source).toBe("slack");
    expect(events[0].actor).toBe("Lin Chen");
    expect(events[0].channel).toBe("meridian-billing");
    expect(events[0].ts).toBe("2024-09-24T00:00:00.000Z");
    expect(events[1].actor).toBe("Dana Okafor");
  });

  it("derives the channel name from the file name", () => {
    const { events } = parseSlackFiles(files(true));
    expect(events.every((event) => event.channel === "meridian-billing")).toBe(true);
  });

  it("gives thread replies the same threadId as their parent", () => {
    const { events } = parseSlackFiles(files(true));
    expect(events[0].threadId).toBe("slack:meridian-billing:1727136000.000100");
    expect(events[1].threadId).toBe(events[0].threadId);
    expect(events[2].threadId).toBe(events[0].threadId);
  });

  it("keeps subtype messages as events with meta.subtype and falls back to username", () => {
    const { events } = parseSlackFiles(files(true));
    const join = events.find((event) => event.meta?.subtype === "channel_join");
    expect(join).toBeDefined();
    expect(join!.actor).toBe("Priya Nair");
    const bot = events.find((event) => event.meta?.subtype === "bot_message");
    expect(bot).toBeDefined();
    expect(bot!.actor).toBe("alertbot");
  });

  it("extracts ticket refs from message text", () => {
    const { events } = parseSlackFiles(files(true));
    expect(events[0].refs).toContain("MER-101");
    const bot = events.find((event) => event.meta?.subtype === "bot_message");
    expect(bot!.refs).toContain("MER-102");
  });

  it("falls back to raw ids when users.json is missing, without throwing", () => {
    const { events } = parseSlackFiles(files(false));
    expect(events).toHaveLength(5);
    expect(events[0].actor).toBe("U1");
  });

  it("returns zero events for non-array channel JSON without throwing", () => {
    const { events } = parseSlackFiles([
      { name: "users.json", json: users },
      { name: "meridian-billing.json", json: { not: "an array" } },
    ]);
    expect(events).toEqual([]);
  });

  it("degrades gracefully on malformed input", () => {
    expect(parseSlackFiles([]).events).toEqual([]);
    expect(parseSlackFiles(null as unknown as []).events).toEqual([]);
    expect(parseSlackFiles([{ name: "x.json", json: [null, "str", 7, { noTs: true }] }]).events).toEqual([]);
  });
});
