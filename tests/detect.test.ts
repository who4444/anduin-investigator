import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { detectFile, expandArchives, type IngestFile } from "../lib/ingest/detect";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const file = (name: string, content: string): IngestFile => ({ name, bytes: encode(content) });

describe("detectFile", () => {
  it("classifies a Jira search response", () => {
    const jira = file("search.json", JSON.stringify({ issues: [{ key: "MER-101", fields: {} }] }));
    expect(detectFile(jira).kind).toBe("jira");
  });

  it("classifies a single Jira issue object", () => {
    const jira = file("MER-101.json", JSON.stringify({ key: "MER-101", fields: { summary: "bug" } }));
    const detected = detectFile(jira);
    expect(detected.kind).toBe("jira");
    expect(detected.json).toBeDefined();
  });

  it("classifies an id-shaped Jira issue without misrouting it to Slack", () => {
    const jira = file(
      "issue.json",
      JSON.stringify({ id: "10001", fields: { summary: "Totals wrong", name: "billing" } }),
    );
    expect(detectFile(jira).kind).toBe("jira");
  });

  it("classifies Slack user maps by content and by name", () => {
    const users = JSON.stringify({ U1: { real_name: "Lin Chen" } });
    expect(detectFile(file("users.json", users)).kind).toBe("slack-users");
    expect(detectFile(file("team.json", users)).kind).toBe("slack-users");
  });

  it("classifies a Slack channels array", () => {
    const channels = JSON.stringify([{ id: "C1", name: "meridian-billing" }]);
    expect(detectFile(file("channels.json", channels)).kind).toBe("slack-channels");
  });

  it("classifies Slack message arrays", () => {
    const messages = JSON.stringify([{ ts: "1727136000.000100", user: "U1", text: "hello" }]);
    expect(detectFile(file("meridian-billing/2024-09-24.json", messages)).kind).toBe("slack-messages");
  });

  it("classifies by extension for email and zip", () => {
    expect(detectFile(file("thread.mbox", "From x")).kind).toBe("email-mbox");
    expect(detectFile(file("reply.eml", "From: x")).kind).toBe("email-eml");
    expect(detectFile({ name: "export.zip", bytes: new Uint8Array([1, 2, 3]) }).kind).toBe("zip");
  });

  it("returns unknown for unrecognised or invalid content", () => {
    expect(detectFile(file("notes.txt", "hello")).kind).toBe("unknown");
    expect(detectFile(file("broken.json", "{not json")).kind).toBe("unknown");
    expect(detectFile(file("misc.json", JSON.stringify({ foo: 1 }))).kind).toBe("unknown");
  });
});

describe("expandArchives", () => {
  it("unpacks a zip into its member files and detects them", () => {
    const jira = JSON.stringify({ issues: [{ key: "MER-101", fields: {} }] });
    const zipped = zipSync({ "export/search.json": encode(jira) });

    const expanded = expandArchives([{ name: "export.zip", bytes: zipped }]);

    expect(expanded).toHaveLength(1);
    expect(expanded[0].name).toBe("export/search.json");
    expect(detectFile(expanded[0]).kind).toBe("jira");
  });

  it("falls back to the original file when the zip cannot be read", () => {
    const expanded = expandArchives([{ name: "broken.zip", bytes: new Uint8Array([1, 2, 3]) }]);
    expect(expanded).toHaveLength(0);
  });

  it("warns and skips an unreadable archive", () => {
    const warnings: string[] = [];
    const expanded = expandArchives([{ name: "broken.zip", bytes: new Uint8Array([1, 2, 3]) }], {
      warnings,
    });

    expect(expanded).toHaveLength(0);
    expect(warnings).toEqual(["Unreadable archive: broken.zip"]);
  });

  it("warns and skips an archive that inflates past the budget", () => {
    const zipped = zipSync({ "big.json": encode("[]".padEnd(4096, " ")) });
    const warnings: string[] = [];

    const expanded = expandArchives([{ name: "bomb.zip", bytes: zipped }], {
      warnings,
      maxDecompressedBytes: 1024,
    });

    expect(expanded).toHaveLength(0);
    expect(warnings[0]).toMatch(/expands beyond 1024 bytes/);
  });

  it("stops when many small members together exceed the budget", () => {
    const members: Record<string, Uint8Array> = {};
    for (let index = 0; index < 20; index += 1) {
      members[`part-${index}.json`] = encode("x".repeat(500));
    }
    const zipped = zipSync(members);
    const warnings: string[] = [];

    const expanded = expandArchives([{ name: "many.zip", bytes: zipped }], {
      warnings,
      maxDecompressedBytes: 4096,
    });

    expect(expanded).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});
