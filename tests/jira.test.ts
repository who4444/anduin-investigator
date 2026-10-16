import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseJira } from "../lib/ingest/jira";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

describe("parseJira", () => {
  const search = fixture("jira-search.json");

  it("parses a search-shaped response with every event kind", () => {
    const { events, issues } = parseJira(search);
    expect(issues).toEqual([
      { key: "MER-101", summary: "Invoice totals wrong for Q3" },
      { key: "MER-102", summary: "Login page CSS glitch" },
    ]);
    // MER-101: created + 2 comments + 2 status + 1 assignee + 1 resolution = 7
    // MER-102: created = 1
    expect(events).toHaveLength(8);
  });

  it("emits the first event with reporter, issue-key channel and exact fixture ts", () => {
    const { events } = parseJira(search);
    const first = events[0];
    expect(first.source).toBe("jira");
    expect(first.actor).toBe("Dana Okafor");
    expect(first.channel).toBe("MER-101");
    expect(first.ts).toBe("2024-09-10T08:15:00.000+0000");
    expect(first.url).toBe("https://northwind.atlassian.net/browse/MER-101");
  });

  it("strips HTML tags from comment bodies", () => {
    const { events } = parseJira(search);
    const comment = events.find((event) => event.ts === "2024-09-10T10:30:00.000+0000");
    expect(comment).toBeDefined();
    expect(comment!.text).toBe("Can you confirm the fix date?");
    expect(comment!.text).not.toContain("<p>");
  });

  it("records status transitions with from → to and the changelog author", () => {
    const { events } = parseJira(search);
    const statusEvents = events.filter((event) => event.text.startsWith("Status:"));
    expect(statusEvents).toHaveLength(2);
    expect(statusEvents[0].text).toBe("Status: Open → In Progress");
    expect(statusEvents[0].actor).toBe("Priya Nair");
    expect(statusEvents[1].text).toBe("Status: In Progress → Resolved");
  });

  it("parses a single issue object with no changelog (zero status events)", () => {
    const { events, issues } = parseJira(fixture("jira-single.json"));
    expect(issues).toEqual([{ key: "MER-103", summary: "Export button does nothing" }]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((event) => event.text.startsWith("Status:"))).toHaveLength(0);
    expect(events[0].channel).toBe("MER-103");
  });

  it("converts Atlassian Document Format bodies (Jira Cloud v3) into plain text", () => {
    const adfText = (text: string) => ({ type: "text", text });
    const paragraph = (...texts: string[]) => ({
      type: "paragraph",
      content: texts.map(adfText),
    });
    const issue = {
      key: "NW-1",
      self: "https://acme.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Invoice totals wrong for Q3",
        created: "2024-09-10T08:15:00.000+0000",
        reporter: { displayName: "Dana Okafor" },
        description: {
          type: "doc",
          version: 1,
          content: [paragraph("Totals drifted after the 4.12 release. See MER-99 for the rollback plan.")],
        },
        comment: {
          comments: [
            {
              created: "2024-09-10T10:30:00.000+0000",
              author: { displayName: "Priya Nair" },
              body: {
                type: "doc",
                version: 1,
                content: [
                  paragraph("We will ship the fix by Sep 24."),
                  paragraph("Confirmed the drift is timezone-related."),
                ],
              },
            },
          ],
        },
      },
    };

    const { events } = parseJira({ issues: [issue] });

    const comment = events.find((event) => event.ts === "2024-09-10T10:30:00.000+0000");
    expect(comment).toBeDefined();
    expect(comment!.text).toContain("We will ship the fix by Sep 24.");
    expect(comment!.text).toContain("Confirmed the drift is timezone-related.");
    expect(comment!.text).not.toContain("[object Object]");

    const created = events.find((event) => event.text.startsWith("Issue created"));
    expect(created).toBeDefined();
    const refs = [...(created?.refs ?? []), ...(comment?.refs ?? [])];
    expect(refs).toContain("MER-99");
  });

  it("leaves v2-style HTML string bodies working alongside ADF", () => {
    const issue = {
      key: "NW-2",
      fields: {
        summary: "Legacy export",
        created: "2024-09-10T08:15:00.000+0000",
        comment: {
          comments: [
            {
              created: "2024-09-10T11:00:00.000+0000",
              author: "Dana Okafor",
              body: "<p>Old-style <b>HTML</b> body</p>",
            },
          ],
        },
      },
    };
    const { events } = parseJira({ issues: [issue] });
    const comment = events.find((event) => event.ts === "2024-09-10T11:00:00.000+0000");
    expect(comment!.text).toBe("Old-style HTML body");
  });

  it("handles an empty search response without throwing", () => {
    expect(parseJira({ issues: [] })).toEqual({ events: [], issues: [] });
  });

  it("handles malformed input without throwing", () => {
    expect(parseJira(null).events).toEqual([]);
    expect(parseJira(undefined).events).toEqual([]);
    expect(parseJira("nope").events).toEqual([]);
    expect(parseJira(42).events).toEqual([]);
    expect(parseJira({ issues: [null, "x", 7] }).events).toEqual([]);
  });
});
