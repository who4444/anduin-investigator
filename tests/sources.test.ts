import { describe, expect, it, vi } from "vitest";

import { parseMbox } from "../lib/ingest/email";
import { parseSlackFiles } from "../lib/ingest/slack";
import { createGmailSource } from "../lib/sources/gmail";
import { createJiraSource } from "../lib/sources/jira";
import { createSlackSource } from "../lib/sources/slack";

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function router(handlers: Array<[RegExp, (url: URL, init?: RequestInit) => Response]>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(url.toString())) return handler(url, init);
    }
    throw new Error(`Unexpected request: ${url.toString()}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const jiraEnv = {
  JIRA_SITE: "northwind.atlassian.net",
  JIRA_EMAIL: "you@northwind.example",
  JIRA_API_TOKEN: "token-123",
};

describe("jira source", () => {
  it("reports configuration from env", () => {
    const source = createJiraSource({ env: {}, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(source.isConfigured()).toBe(false);
    expect(source.missingEnv()).toEqual(["JIRA_SITE", "JIRA_EMAIL", "JIRA_API_TOKEN"]);

    const configured = createJiraSource({ env: jiraEnv, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(configured.isConfigured()).toBe(true);
  });

  it("lists projects and pulls paginated issues with changelog", async () => {
    const { fetchImpl, calls } = router([
      [
        /project\/search/,
        () => json({ values: [{ key: "MER", name: "Meridian" }, { key: "SUP", name: "Support" }] }),
      ],
      [
        /rest\/api\/3\/search\/jql/,
        (url) => {
          const token = url.searchParams.get("nextPageToken");
          if (!token) {
            return json({
              issues: Array.from({ length: 50 }, (_, index) => ({ key: `MER-${index}` })),
              nextPageToken: "page-2",
              isLast: false,
            });
          }
          return json({ issues: [{ key: "MER-50" }], isLast: true });
        },
      ],
    ]);

    const source = createJiraSource({ env: jiraEnv, fetchImpl });
    const targets = await source.listTargets();
    expect(targets).toEqual([
      { id: "MER", label: "MER · Meridian" },
      { id: "SUP", label: "SUP · Support" },
    ]);

    const { files, warnings } = await source.pull(["MER"]);

    expect(warnings).toEqual([]);
    expect(files.map((file) => file.name)).toEqual(["jira/MER-page-1.json", "jira/MER-page-2.json"]);
    const secondFile = JSON.parse(files[1].content) as { issues: { key: string }[] };
    expect(secondFile.issues).toHaveLength(1);

    const searchCall = calls.find((call) => call.url.includes("rest/api/3/search/jql"));
    expect(searchCall?.url).toContain("expand=changelog");
    const headers = searchCall?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("you@northwind.example:token-123").toString("base64")}`);
  });

  it("warns when the page budget is hit", async () => {
    const { fetchImpl } = router([
      [
        /rest\/api\/3\/search\/jql/,
        () =>
          json({
            issues: Array.from({ length: 50 }, (_, index) => ({ key: `MER-${index}` })),
            nextPageToken: "more",
            isLast: false,
          }),
      ],
    ]);

    const source = createJiraSource({ env: jiraEnv, fetchImpl });
    const { files, warnings } = await source.pull(["MER"]);

    expect(files).toHaveLength(4);
    expect(warnings[0]).toMatch(/4-page budget/);
  });

  it("surfaces a helpful error on auth failure", async () => {
    const { fetchImpl } = router([[/rest\/api\/3\/search\/jql/, () => json({}, 401)]]);
    const source = createJiraSource({ env: jiraEnv, fetchImpl });

    await expect(source.pull(["MER"])).rejects.toThrow(/JIRA_EMAIL and JIRA_API_TOKEN/);
  });
});

const slackEnv = { SLACK_TOKEN: "xoxp-test" };

function slackHandlers(channelName = "meridian-billing") {
  return router([
    [
      /conversations\.list/,
      () => json({ ok: true, channels: [{ id: "C1", name: "general" }, { id: "C2", name: channelName }] }),
    ],
    [
      /conversations\.info/,
      () => json({ ok: true, channel: { id: "C2", name: channelName } }),
    ],
    [
      /conversations\.history/,
      (_url, init) => {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("cursor") === "next") {
          return json({ ok: true, messages: [{ ts: "1727254800.000100", user: "U1", text: "second page" }] });
        }
        return json({
          ok: true,
          messages: [
            { ts: "1727251200.000100", user: "U2", text: "fix is in the Sep 24 build" },
            { ts: "1727251500.000100", user: "U1", text: "QA is still failing", thread_ts: "1727251200.000100" },
          ],
          response_metadata: { next_cursor: "next" },
        });
      },
    ],
    [
      /users\.list/,
      () =>
        json({
          ok: true,
          members: [
            { id: "U1", name: "linchen", real_name: "Lin Chen", profile: { real_name: "Lin Chen" } },
            { id: "U2", name: "marcus", real_name: "Marcus Webb", profile: { real_name: "Marcus Webb" } },
          ],
        }),
    ],
  ]);
}

describe("slack source", () => {
  it("lists channels and pulls users, channels and messages that round-trip through the parser", async () => {
    const { fetchImpl } = slackHandlers();
    const source = createSlackSource({ env: slackEnv, fetchImpl });

    const targets = await source.listTargets();
    expect(targets).toEqual([
      { id: "C1", label: "#general" },
      { id: "C2", label: "#meridian-billing" },
    ]);

    const { files, warnings } = await source.pull(["C2"]);
    expect(warnings).toEqual([]);
    expect(files.map((file) => file.name)).toEqual([
      "slack/users.json",
      "slack/meridian-billing/messages.json",
      "slack/channels.json",
    ]);

    const parsed = parseSlackFiles(
      files.map((file) => ({ name: file.name, json: JSON.parse(file.content) as unknown })),
    );
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[0].actor).toBe("Marcus Webb");
    expect(parsed.events[0].channel).toBe("meridian-billing");
    expect(parsed.events[1].threadId).toBe("slack:meridian-billing:1727251200.000100");
  });

  it("explains missing scopes when Slack rejects the call", async () => {
    const { fetchImpl } = router([
      [/users\.list/, () => json({ ok: false, error: "missing_scope", needed: "users:read" })],
    ]);
    const source = createSlackSource({ env: slackEnv, fetchImpl });

    await expect(source.pull(["C2"])).rejects.toThrow(/users:read/);
  });

  it("explains token problems", async () => {
    const { fetchImpl } = router([[/users\.list/, () => json({ ok: false, error: "invalid_auth" })]]);
    const source = createSlackSource({ env: slackEnv, fetchImpl });

    await expect(source.pull(["C2"])).rejects.toThrow(/Check SLACK_TOKEN/);
  });
});

const gmailEnv = {
  GMAIL_CLIENT_ID: "client-1",
  GMAIL_CLIENT_SECRET: "secret-1",
  GMAIL_REFRESH_TOKEN: "refresh-1",
};

const rawEmail = [
  "From: Priya Nair <priya.nair@northwind.example>",
  "To: Marcus Webb <marcus.webb@meridian-software.example>",
  "Subject: totals still wrong",
  "Date: Tue, 24 Sep 2024 09:30:00 +0800",
  "Message-ID: <g1@northwind.example>",
  "",
  "Totals are still wrong.",
  "From the desk of Priya",
  "",
].join("\r\n");

describe("gmail source", () => {
  it("mints one access token and reuses it", async () => {
    let tokenCalls = 0;
    const { fetchImpl, calls } = router([
      [
        /oauth2\.googleapis\.com\/token/,
        () => {
          tokenCalls += 1;
          return json({ access_token: "access-1", expires_in: 3600 });
        },
      ],
      [/users\/me\/messages\?/, () => json({ messages: [{ id: "m1" }] })],
      [
        /users\/me\/messages\/m1/,
        () => json({ raw: Buffer.from(rawEmail, "utf8").toString("base64url") }),
      ],
    ]);

    const source = createGmailSource({ env: { ...gmailEnv, GMAIL_MAX_MESSAGES: "5" }, fetchImpl });
    await source.pull(["search"], "label:meridian");
    await source.pull(["search"], "label:meridian");

    expect(tokenCalls).toBe(1);
    expect(calls.filter((call) => call.url.includes("/messages/m1")).length).toBe(2);
  });

  it("emits an mbox that the real parser reads, with From-lines escaped", async () => {
    const { fetchImpl } = router([
      [/oauth2\.googleapis\.com\/token/, () => json({ access_token: "access-1", expires_in: 3600 })],
      [/users\/me\/messages\?/, () => json({ messages: [{ id: "m1" }] })],
      [/users\/me\/messages\/m1/, () => json({ raw: Buffer.from(rawEmail, "utf8").toString("base64url") })],
    ]);

    const source = createGmailSource({ env: gmailEnv, fetchImpl });
    const { files } = await source.pull(["search"], "label:meridian");

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("gmail/messages-1.mbox");

    const parsed = await parseMbox(new TextEncoder().encode(files[0].content));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].actor).toBe("Priya Nair <priya.nair@northwind.example>");
    expect(parsed.events[0].ts).toBe("2024-09-24T01:30:00.000Z");
    expect(parsed.events[0].text).toContain("From the desk of Priya");
  });

  it("requires a search query", async () => {
    const source = createGmailSource({ env: gmailEnv, fetchImpl: vi.fn() as unknown as typeof fetch });

    await expect(source.pull(["search"])).rejects.toThrow(/search query/i);
  });

  it("caps the number of pulled messages", async () => {
    const { fetchImpl } = router([
      [/oauth2\.googleapis\.com\/token/, () => json({ access_token: "access-1", expires_in: 3600 })],
      [
        /users\/me\/messages\?/,
        () =>
          json({
            messages: Array.from({ length: 100 }, (_, index) => ({ id: `m${index}` })),
            nextPageToken: "more",
          }),
      ],
      [
        /users\/me\/messages\/m\d+/,
        () => json({ raw: Buffer.from(rawEmail, "utf8").toString("base64url") }),
      ],
    ]);

    const source = createGmailSource({ env: { ...gmailEnv, GMAIL_CLIENT_ID: "client-cap", GMAIL_MAX_MESSAGES: "3" }, fetchImpl });
    const { warnings } = await source.pull(["search"], "label:meridian");

    expect(warnings[0]).toMatch(/newest 3 matching messages/);
  });

  it("explains a rejected refresh token", async () => {
    const { fetchImpl } = router([[/oauth2\.googleapis\.com\/token/, () => json({ error: "invalid_grant" }, 400)]]);
    const source = createGmailSource({ env: { ...gmailEnv, GMAIL_CLIENT_ID: "client-rejected" }, fetchImpl });

    await expect(source.pull(["search"], "label:x")).rejects.toThrow(/Re-mint GMAIL_REFRESH_TOKEN/);
  });
});
