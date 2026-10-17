import { readFileSync } from "node:fs";

import { expect, test, type APIRequestContext } from "@playwright/test";

/* Scope-confidence disclosure: a vague escalation must never present its
   guess as confirmed, and an unconfirmable scope must say so. */

const DEMO_FILES = [
  ["jira-meridian.json", "application/json"],
  ["northwind-emails.mbox", "application/mbox"],
  ["escalation.eml", "message/rfc822"],
  ["slack/users.json", "application/json"],
  ["slack/channels.json", "application/json"],
  ["slack/meridian-billing/messages.json", "application/json"],
  ["slack/general/messages.json", "application/json"],
] as const;

async function seed(
  request: APIRequestContext,
  escalation: string,
  client: string,
): Promise<string> {
  const form = new FormData();
  for (const [name, mimeType] of DEMO_FILES) {
    form.append("files", new File([readFileSync(`public/demo/${name}`)], name, { type: mimeType }));
  }
  form.append("escalation", escalation);
  form.append("client", client);
  form.append("title", `Scope ${escalation.slice(0, 24)}`);

  const created = await request.post("/api/investigations", { multipart: form });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };

  for (const [stage, body] of [
    ["plan", { pass: 1 }],
    ["investigate", { kind: "root_cause", pass: 1 }],
    ["investigate", { kind: "commitments", pass: 1 }],
    ["investigate", { kind: "ownership", pass: 1 }],
    ["skeptic", { pass: 1 }],
    ["verify", { pass: 1 }],
    ["assemble", { pass: 1 }],
  ] as const) {
    const response = await request.post(`/api/investigations/${investigationId}/${stage}`, {
      data: body,
    });
    expect(response.status(), `${stage} stage`).toBe(200);
  }
  return `/investigations/${investigationId}?synthetic=1`;
}

test("a vague escalation runs as partial scope with a loud disclosure", async ({ page, request }) => {
  const url = await seed(
    request,
    "Our billing module has been wrong since the last update. Please explain.",
    "",
  );

  await page.goto(url);
  await expect(page.locator(".scope-flag")).toContainText("Unconfirmed scope");
  await expect(page.locator(".scope-line.tone-partial")).toContainText("meridian-billing");
  await expect(page.locator(".scope-line.tone-partial")).toContainText("verify before relying on it");
});

test("an unverifiable declared client falls back to an honest no-scope line", async ({
  page,
  request,
}) => {
  const url = await seed(
    request,
    "Escalation from Ghost Client Corp about a problem we cannot place.",
    "Ghost Client Corp",
  );

  await page.goto(url);
  await expect(page.locator(".scope-line.tone-none")).toContainText("No scope could be confirmed for Ghost Client Corp");
});
