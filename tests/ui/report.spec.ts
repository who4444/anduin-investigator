import { readFileSync } from "node:fs";

import { expect, test, type APIRequestContext } from "@playwright/test";

/* Seeded-report checks: the pipeline is driven through the API with the fake
   LLM, then the rendered report is exercised in the browser. */

const DEMO_FILES = [
  ["jira-meridian.json", "application/json"],
  ["northwind-emails.mbox", "application/mbox"],
  ["escalation.eml", "message/rfc822"],
  ["slack/users.json", "application/json"],
  ["slack/channels.json", "application/json"],
  ["slack/meridian-billing/messages.json", "application/json"],
  ["slack/general/messages.json", "application/json"],
] as const;

let reportUrl = "";

async function runStage(
  request: APIRequestContext,
  id: string,
  stage: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await request.post(`/api/investigations/${id}/${stage}`, { data: body });
  expect(response.status(), `${stage} stage`).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

test.beforeAll(async ({ request }) => {
  const form = new FormData();
  for (const [name, mimeType] of DEMO_FILES) {
    form.append("files", new File([readFileSync(`public/demo/${name}`)], name, { type: mimeType }));
  }
  form.append("escalation", "Invoice totals wrong since 4.12; four chases unanswered.");
  form.append("title", "UI harness scenario");

  // 201 = freshly ingested; 200 = a previous run left the same seed cached.
  // Either way the id is real and the pipeline below re-runs over it.
  const created = await request.post("/api/investigations", { multipart: form });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };

  await runStage(request, investigationId, "plan", { pass: 1 });
  for (const kind of ["root_cause", "commitments", "ownership"]) {
    await runStage(request, investigationId, "investigate", { kind, pass: 1 });
  }
  await runStage(request, investigationId, "skeptic", { pass: 1 });
  await runStage(request, investigationId, "verify", { pass: 1 });
  const assembled = await runStage(request, investigationId, "assemble", { pass: 1 });
  expect(assembled.needsRetry).toBe(false);

  reportUrl = `/investigations/${investigationId}?synthetic=1`;
});

test("scoreboard cells open the evidence drawer with the quoted record", async ({ page }) => {
  await page.goto(reportUrl);

  await page.locator(".scoreboard-cell:not([disabled])").first().click();
  const drawer = page.getByRole("dialog", { name: "Stored original message" });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("mark").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("the timeline appendix stays collapsed until opened, then shows the board", async ({
  page,
}) => {
  await page.goto(reportUrl);

  const appendix = page.locator("#timeline-detail");
  await expect(appendix).not.toHaveAttribute("open");
  // Closed <details> keeps its children in the DOM — they are merely hidden.
  await expect(page.locator(".swimlane")).toBeHidden();

  await appendix.locator("summary").click();
  await expect(appendix).toHaveAttribute("open");
  await expect(page.locator(".swimlane-axis-track")).toBeVisible();
  expect(await page.locator(".legend-item").count()).toBeGreaterThanOrEqual(3);
});

test("draft reply cites verified findings and the draft survives reload", async ({
  page,
}) => {
  await page.goto(reportUrl);
  const verdictBefore = await page.locator(".verdict").innerText();

  // A cached seed may already carry a stored draft — only click when it does not.
  if ((await page.locator(".reply-sentence").count()) === 0) {
    await page.getByRole("button", { name: "Draft the client reply" }).click();
  }
  await expect(page.locator(".reply-sentence").first()).toBeVisible({ timeout: 30_000 });

  await page.reload();
  // G-08: the stored draft survives, but the top answer is the frozen assembled
  // version and must be byte-for-byte unchanged after drafting.
  await expect(page.locator(".reply-sentence").first()).toBeVisible();
  await expect(page.locator(".verdict")).toHaveText(verdictBefore);
});
