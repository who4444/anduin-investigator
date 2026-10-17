import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test, type APIRequestContext } from "@playwright/test";
import { zipSync } from "fflate";

/* Adversarial UI pass: flows the happy-path specs never touch — half-finished
   runs, unknown ids, zip uploads, garbage uploads, print and mobile layouts,
   keyboard-only use, escalation markup, the recent list, reply redraft. */

const DEMO_FILES = [
  ["jira-meridian.json", "application/json"],
  ["northwind-emails.mbox", "application/mbox"],
  ["escalation.eml", "message/rfc822"],
  ["slack/users.json", "application/json"],
  ["slack/channels.json", "application/json"],
  ["slack/meridian-billing/messages.json", "application/json"],
  ["slack/general/messages.json", "application/json"],
] as const;

const DEFAULT_ESCALATION =
  "Meridian reports invoice totals wrong for Bright Market since 4.12 (MER-101).";

function demoForm(escalation: string, client = "Northwind Logistics"): FormData {
  const form = new FormData();
  for (const [name, mimeType] of DEMO_FILES) {
    form.append("files", new File([readFileSync(`public/demo/${name}`)], name, { type: mimeType }));
  }
  form.append("escalation", `${escalation} [${randomUUID()}]`);
  if (client) form.append("client", client);
  form.append("origin", "demo");
  form.append("title", `Robustness ${escalation.slice(0, 24)}`);
  return form;
}

async function seed(
  request: APIRequestContext,
  escalation = DEFAULT_ESCALATION,
  client = "Northwind Logistics",
  stages: "all" | "plan-only" = "all",
): Promise<string> {
  const created = await request.post("/api/investigations", { multipart: demoForm(escalation, client) });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };

  const plan = await request.post(`/api/investigations/${investigationId}/plan`, { data: { pass: 1 } });
  expect(plan.status(), "plan").toBe(200);
  if (stages === "plan-only") return investigationId;

  for (const kind of ["root_cause", "commitments", "ownership"]) {
    const response = await request.post(`/api/investigations/${investigationId}/investigate`, {
      data: { kind, pass: 1 },
    });
    expect(response.status(), kind).toBe(200);
  }
  for (const stage of ["skeptic", "verify", "assemble"]) {
    const response = await request.post(`/api/investigations/${investigationId}/${stage}`, {
      data: { pass: 1 },
    });
    expect(response.status(), stage).toBe(200);
  }
  return investigationId;
}

test("an unknown investigation id serves a 404 instead of crashing", async ({ page }) => {
  const response = await page.goto(`/investigations/${randomUUID()}`);
  expect(response?.status()).toBe(404);
});

test("a report opened mid-run says it is still being produced, then completes", async ({
  page,
  request,
}) => {
  const id = await seed(request, DEFAULT_ESCALATION, "Northwind Logistics", "plan-only");

  await page.goto(`/investigations/${id}`);
  await expect(page.locator(".alert-warn").first()).toContainText("still being produced");
  await expect(page.getByRole("link", { name: "Watch the run" })).toBeVisible();

  for (const kind of ["root_cause", "commitments", "ownership"]) {
    await request.post(`/api/investigations/${id}/investigate`, { data: { kind, pass: 1 } });
  }
  for (const stage of ["skeptic", "verify", "assemble"]) {
    await request.post(`/api/investigations/${id}/${stage}`, { data: { pass: 1 } });
  }

  await page.reload();
  await expect(page.locator(".alert-warn", { hasText: "still being produced" })).toHaveCount(0);
  await expect(page.locator("#answer")).toBeVisible();
});

test("the section nav opens the collapsed timeline appendix", async ({ page, request }) => {
  const id = await seed(request);
  await page.goto(`/investigations/${id}`);

  const appendix = page.locator("#timeline-detail");
  await expect(appendix).not.toHaveAttribute("open");

  await page.getByRole("link", { name: "Timeline detail" }).click();
  await expect(appendix).toHaveAttribute("open");
  await expect(page.locator(".swimlane-axis-track")).toBeVisible();
});

test("print layout keeps the answer and hides interactive chrome", async ({ page, request }) => {
  const id = await seed(request);
  await page.goto(`/investigations/${id}`);

  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".app-header")).toBeHidden();
  await expect(page.locator(".section-index")).toBeHidden();
  await expect(page.locator("#timeline-detail")).toBeHidden();
  await expect(page.locator(".scoreboard-cell").first()).toBeVisible();
  await expect(page.locator(".scope-line").first()).toBeVisible();
});

test("a 375px viewport keeps the story readable", async ({ page, request }) => {
  const id = await seed(request);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/investigations/${id}`);

  // The swimlane is deliberately hidden on small screens; the chapters carry
  // the same events.
  await expect(page.locator(".swimlane-wrap")).toBeHidden();
  await expect(page.locator(".scoreboard-cell").first()).toBeVisible();
  await expect(page.locator(".chapter").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
});

test("keyboard-only: the drawer opens from a scoreboard cell and Esc restores focus", async ({
  page,
  request,
}) => {
  const id = await seed(request);
  await page.goto(`/investigations/${id}`);

  const cell = page.locator(".scoreboard-cell:not([disabled])").first();
  await cell.focus();
  await page.keyboard.press("Enter");

  const drawer = page.getByRole("dialog", { name: "Stored original message" });
  await expect(drawer).toBeVisible();
  const focusInside = await page.evaluate(
    () => document.activeElement?.closest(".drawer") !== null,
  );
  expect(focusInside).toBe(true);

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  const focusRestored = await page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.classList.contains("scoreboard-cell") ?? false,
  );
  expect(focusRestored).toBe(true);
});

test("a zip of the exports uploads and runs through the upload page", async ({ page }) => {
  const zip = zipSync(
    {
      "jira-meridian.json": readFileSync("public/demo/jira-meridian.json"),
      "workspace.mbox": readFileSync("public/demo/northwind-emails.mbox"),
      "slack/users.json": readFileSync("public/demo/slack/users.json"),
      "slack/channels.json": readFileSync("public/demo/slack/channels.json"),
      "slack/meridian-billing/messages.json": readFileSync("public/demo/slack/meridian-billing/messages.json"),
      "slack/general/messages.json": readFileSync("public/demo/slack/general/messages.json"),
    },
    { level: 6 },
  );

  await page.goto("/upload");
  // A run-unique escalation keeps this FRESH every time: the progress page
  // then runs the real orchestrator with its parallel investigators, which is
  // exactly the path that must share one lease.
  await page.locator("textarea").first().fill(`Zip upload check run ${Date.now()}`);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "exports.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await page.getByRole("button", { name: "Investigate these exports" }).click();

  await page.waitForURL(/\/investigations\/[0-9a-f-]+\/progress/, { timeout: 30_000 });
  await expect(page.locator("#answer")).toBeVisible({ timeout: 120_000 });
  // The parallel investigators completed under one shared lease: no
  // "stage is already running" error may be left on the progress screen.
  await expect(page.locator(".alert-error")).toHaveCount(0);
});

test("a garbage-only upload reports the parse failure instead of a broken report", async ({ page }) => {
  await page.goto("/upload");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("nothing here") });
  await page.getByRole("button", { name: "Investigate these exports" }).click();

  await expect(page.locator(".alert-error")).toBeVisible();
  await expect(page.locator(".alert-error")).toContainText(/no events|no messages|unrecognis/i);
  expect(page.url()).toContain("/upload");
});

test("a vague escalation with no declared client gets the honest no-scope line", async ({
  page,
  request,
}) => {
  const id = await seed(request, "Everything about the ghost client project is broken.", "");
  await page.goto(`/investigations/${id}`);
  await expect(page.locator(".scope-line.tone-none")).toContainText(
    "No client or project could be identified",
  );
});

test("markup and unicode in the escalation render as plain text", async ({ page, request }) => {
  const id = await seed(
    request,
    "Totals wrong since 4.12 — caf\u00e9 bill \ud83d\udca5 <img src=x onerror=alert(1)> — MER-101.",
  );
  await page.goto(`/investigations/${id}`);

  const clientSays = page.locator(".client-says");
  await expect(clientSays).toContainText("caf\u00e9");
  await expect(clientSays).toContainText("<img src=x onerror=alert(1)>");
  const injectedImage = await page.evaluate(() => document.querySelector(".client-says img") !== null);
  expect(injectedImage).toBe(false);
});

test("the recent-investigations list links back into a seeded run", async ({ page, request }) => {
  const id = await seed(request, "Recent list check for the dashboard", "Northwind Logistics", "plan-only");

  await page.goto("/");
  const link = page.locator("section", { hasText: "Recent investigations" }).getByRole("link");
  await expect(link.first()).toBeVisible();
  await expect(page.locator("section", { hasText: "Recent investigations" })).toContainText("in progress");

  await page.goto(`/investigations/${id}`);
  await expect(page.locator(".alert-warn").first()).toContainText("still being produced");
});

test("redrafting the reply stays usable and copy confirms", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const id = await seed(request);
  await page.goto(`/investigations/${id}`);

  if ((await page.locator(".reply-sentence").count()) === 0) {
    await page.getByRole("button", { name: "Draft the client reply" }).click();
  }
  await expect(page.locator(".reply-sentence").first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Redraft" }).click();
  await expect(page.locator(".reply-sentence").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".alert-error")).toHaveCount(0);

  await page.getByRole("button", { name: "Copy reply" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
});
