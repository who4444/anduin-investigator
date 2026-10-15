import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/ingest/refs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ingest/refs")>();
  return {
    ...actual,
    extractTicketRefs: (text: string) => {
      if (text.includes("BOOM-CONSTRUCTION")) throw new Error("construction boom");
      return actual.extractTicketRefs(text);
    },
  };
});

import { parseEml, parseMbox } from "../lib/ingest/email";

const here = dirname(fileURLToPath(import.meta.url));
function bytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(here, "fixtures", name)));
}

describe("parseMbox", () => {
  it("parses all three messages from the mbox", async () => {
    const { events } = await parseMbox(bytes("sample.mbox"));
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.source === "email")).toBe(true);
    expect(events.every((event) => event.channel === "email")).toBe(true);
  });

  it("converts +0800 Date headers to UTC ISO and uses the From display name", async () => {
    const { events } = await parseMbox(bytes("sample.mbox"));
    expect(events[0].ts).toBe("2024-09-24T01:30:00.000Z");
    expect(events[0].actor).toBe("Dana Okafor");
    expect(events[1].actor).toBe("Priya Nair");
    expect(events[1].ts).toBe("2024-09-24T03:00:00.000Z");
  });

  it("links a reply to its thread root via In-Reply-To/References", async () => {
    const { events, threads } = await parseMbox(bytes("sample.mbox"));
    expect(events[1].threadId).toBeDefined();
    expect(events[1].threadId).toBe(events[0].threadId);
    const list = threads.get(events[0].threadId!) ?? [];
    expect(list).toContain("root-1@northwind.example");
    expect(list).toContain("reply-2@northwind.example");
  });

  it("converts an HTML body to plain text and decodes entities", async () => {
    const { events } = await parseMbox(bytes("sample.mbox"));
    const htmlEvent = events.find((event) => event.ts === "2024-09-25T06:15:00.000Z");
    expect(htmlEvent).toBeDefined();
    expect(htmlEvent!.text).toBe("Escalating SUP-2231. Client needs an ETA & a fix.");
    expect(htmlEvent!.text).not.toContain("<p>");
    expect(htmlEvent!.text).not.toContain("&nbsp;");
  });

  it("extracts SUP-2231 from the subject into refs", async () => {
    const { events } = await parseMbox(bytes("sample.mbox"));
    expect(events[2].refs).toContain("SUP-2231");
  });

  it("isolates a message that fails construction so others still yield events", async () => {
    const raw = new TextEncoder().encode(
      [
        "From alice@nw.example Tue Sep 24 09:30:00 2024",
        "From: Alice <alice@nw.example>",
        "Date: Tue, 24 Sep 2024 09:30:00 +0800",
        "Subject: first",
        "Message-ID: <iso-1@nw.example>",
        "",
        "first body",
        "From bob@nw.example Tue Sep 24 10:30:00 2024",
        "From: Bob <bob@nw.example>",
        "Date: Tue, 24 Sep 2024 10:30:00 +0800",
        "Subject: BOOM-CONSTRUCTION",
        "Message-ID: <iso-2@nw.example>",
        "",
        "second body",
        "From carol@nw.example Tue Sep 24 11:30:00 2024",
        "From: Carol <carol@nw.example>",
        "Date: Tue, 24 Sep 2024 11:30:00 +0800",
        "Subject: third",
        "Message-ID: <iso-3@nw.example>",
        "",
        "third body",
        "",
      ].join("\n"),
    );
    const { events } = await parseMbox(raw);
    expect(events.map((event) => event.actor)).toEqual(["Alice", "Carol"]);
  });
});

describe("parseEml", () => {
  it("parses a single .eml file into one event", async () => {
    const { events } = await parseEml(bytes("single.eml"));
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("email");
    expect(events[0].actor).toBe("Lin Chen");
    expect(events[0].channel).toBe("email");
    expect(events[0].ts).toBe("2024-09-26T03:00:00.000Z");
  });

  it("returns zero events for garbage/truncated bytes without throwing", async () => {
    const garbage = new Uint8Array([0, 255, 254, 1, 2, 3, 200, 33]);
    await expect(parseEml(garbage)).resolves.toMatchObject({ events: [] });
    await expect(parseMbox(garbage)).resolves.toMatchObject({ events: [] });
    expect((await parseMbox(new Uint8Array(0))).events).toEqual([]);
  });

  it("keeps the event when an HTML body contains an out-of-range numeric entity", async () => {
    const raw = new TextEncoder().encode(
      "From: A <a@x.com>\nDate: Tue, 24 Sep 2024 09:30:00 +0800\nSubject: x\nContent-Type: text/html; charset=utf-8\n\n<p>bad &#99999999; entity</p>\n",
    );
    const { events } = await parseEml(raw);
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe("bad entity");
  });
});
