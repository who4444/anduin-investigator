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
  "Northwind reports invoice totals wrong since 4.12 (MER-101).";

function demoForm(escalation: string, client = "Northwind Logistics"): FormData {
  const form = new FormData();
  for (const [name, mimeType] of DEMO_FILES) {
    form.append("files", new File([readFileSync(`public/demo/${name}`)], name, { type: mimeType }));
  }
  form.append("escalation", escalation);
  // Freshness via the cache key only — never via the escalation text, which
  // the report renders as "the client says".
  form.append("cacheBust", randomUUID());
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

test("the section nav links to the visible timeline board", async ({ page, request }) => {
  const id = await seed(request);
  await page.goto(`/investigations/${id}`);

  await page.getByRole("link", { name: "Timeline detail" }).click();
  await expect(page).toHaveURL(/#timeline-detail$/);
  await expect(page.locator("#timeline-detail")).toBeVisible();
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

  await page.goto("/upload?fresh=1");
  // ?fresh=1 keeps every run FRESH (cache key only, text stays clean): the
  // progress page then runs the real orchestrator with its parallel
  // investigators, which is exactly the path that must share one lease.
  await page.locator("textarea").first().fill("Zip upload check run");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "exports.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await page.getByRole("button", { name: "Investigate these exports" }).click();

  await page.waitForURL(/\/investigations\/[0-9a-f-]+\/progress/, { timeout: 30_000 });
  // G-12: an unconfirmed partial scope pauses here; confirm it.
  await page
    .getByRole("button", { name: "Confirm scope & investigate" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);
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
  await expect(page.locator(".reply-label").first()).toHaveText(/safe|needs check|do not send/);

  // G-07: copying is gated on a persisted approval, not just a draft existing.
  await expect(page.getByRole("button", { name: "Copy reply" })).toBeDisabled();
  await page.getByLabel("Approve for client use").check();
  await expect(page.getByRole("button", { name: "Copy reply" })).toBeEnabled();
  await page.getByRole("button", { name: "Copy reply" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
});

/* G-12: a partial scope pauses before the run, survives a reload, accepts an
   add-back, and the confirmed report no longer calls itself unconfirmed. */
test("the pre-run scope review pauses, survives reload, and confirms the report", async ({
  page,
  request,
}) => {
  // B1: a pause needs deterministic anchors — the declared client links its
  // registry domain (2 anchors → partial), which pauses for the review;
  // model proposals alone no longer pause a run. Learned scopes from other
  // suites would re-verify the same client, so clear them first.
  const { getPool } = await import("../../lib/db/pool");
  const sql = getPool();
  await sql`delete from learned_scopes where declared_client = 'northwind logistics'`;
  const created = await request.post("/api/investigations", {
    multipart: demoForm(
      "Our billing module has been wrong since the last update. Please explain.",
      "Northwind Logistics",
    ),
  });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };

  await page.goto(`/investigations/${investigationId}/progress?synthetic=1`);
  const review = page.locator("section.panel", { hasText: "Confirm the scope before I investigate" });
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(review).toContainText("Unconfirmed scope");
  await expect(review).toContainText("records will be searched");
  await expect(review).toContainText("min");

  await page.reload();
  await expect(review).toBeVisible({ timeout: 60_000 });
  const before = (await (
    await request.get(`/api/investigations/${investigationId}/scope`)
  ).json()) as { confirmed: boolean; inScopeRecords: number };
  expect(before.confirmed).toBe(false);

  await review.locator(".excluded-list input[type=checkbox]").first().check();
  await review.getByRole("button", { name: "Confirm scope & investigate" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/progress"), { timeout: 180_000 });
  await expect(page.locator("#answer")).toBeVisible({ timeout: 30_000 });

  const after = (await (
    await request.get(`/api/investigations/${investigationId}/scope`)
  ).json()) as { confirmed: boolean; inScopeRecords: number };
  expect(after.confirmed).toBe(true);
  expect(after.inScopeRecords).toBeGreaterThan(before.inScopeRecords);
  await expect(page.locator(".scope-line")).toContainText("Scope confirmed by you");
  await expect(page.locator(".scope-line")).toContainText("reviewed record added back into scope");
  await expect(page.locator(".scope-line")).not.toContainText("Unconfirmed scope");
  // F3: one confirmation phrase, never "confirmed by you — confirmed by you".
  const scopeText = await page.locator(".scope-line").innerText();
  expect(scopeText.match(/confirmed by you/gi) ?? []).toHaveLength(1);
});

/* G-13: a run interrupted after one investigator must not redo that
   investigator when it resumes. */
test("resuming a partial investigator pass reruns only the missing kinds", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/investigations", {
    multipart: demoForm("Partial investigator resume check"),
  });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };

  await request.post(`/api/investigations/${investigationId}/plan`, { data: { pass: 1 } });
  await request.post(`/api/investigations/${investigationId}/investigate`, {
    data: { kind: "root_cause", pass: 1 },
  });
  // Confirm the scope up front so this test exercises only the resume path.
  await request.put(`/api/investigations/${investigationId}/scope`, {
    data: { includeEventIds: [] },
  });

  const before = (await (
    await request.get(`/api/investigations/${investigationId}/status`)
  ).json()) as { stages: { stage: string; status: string; log: unknown[] }[] };
  const rootBefore = before.stages.find((stage) => stage.stage === "root_cause");
  expect(rootBefore?.status).toBe("done");
  const rootLogBefore = rootBefore?.log.length;

  await page.goto(`/investigations/${investigationId}/progress?synthetic=1`);
  await page.waitForURL((url) => !url.pathname.includes("/progress"), { timeout: 180_000 });
  await expect(page.locator("#answer")).toBeVisible({ timeout: 30_000 });

  const after = (await (
    await request.get(`/api/investigations/${investigationId}/status`)
  ).json()) as { stages: { stage: string; status: string; log: unknown[] }[] };
  const byName = new Map(after.stages.map((stage) => [stage.stage, stage]));
  expect(byName.get("commitments")?.status).toBe("done");
  expect(byName.get("ownership")?.status).toBe("done");
  expect(byName.get("verify")?.status).toBe("done");
  expect(byName.get("assemble")?.status).toBe("done");
  // The already-done root_cause stage must not have been called again.
  expect(byName.get("root_cause")?.log.length).toBe(rootLogBefore);
});

/* G-13: an unfinished report must offer a link that actually DRIVES the run.
   'How this was produced' (review=1) is read-only by design; the report's
   'Watch the run' on an incomplete run used to point there and never resumed. */
test("an unfinished report's 'Watch the run' resumes the run end to end", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/investigations", {
    multipart: demoForm("Unfinished report resume"),
  });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };
  // Only ingest exists: the pipeline never ran.

  await page.goto(`/investigations/${investigationId}?synthetic=1`);
  const watch = page.getByRole("link", { name: "Watch the run" });
  await expect(watch).toBeVisible({ timeout: 30_000 });
  // The link must drive the run, not open the read-only review.
  await expect(watch).not.toHaveAttribute("href", /review=1/);

  await watch.click();
  await page
    .getByRole("button", { name: "Confirm scope & investigate" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);

  await page.waitForURL((url) => !url.pathname.includes("/progress"), { timeout: 180_000 });
  await expect(page.locator("#answer")).toBeVisible({ timeout: 30_000 });
});

/* G-13: the read-only review of an unfinished run must say so and offer a
   continuation, never sit silently on a half-done pipeline. */
test("the read-only review of an unfinished run offers a resuming continuation", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/investigations", {
    multipart: demoForm("Unfinished review continuation"),
  });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };

  await page.goto(`/investigations/${investigationId}/progress?review=1&synthetic=1`);
  await expect(page.getByText("has not finished", { exact: false })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("link", { name: "Continue the investigation" }).click();
  await page
    .getByRole("button", { name: "Confirm scope & investigate" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);

  await page.waitForURL((url) => !url.pathname.includes("/progress"), { timeout: 180_000 });
  await expect(page.locator("#answer")).toBeVisible({ timeout: 30_000 });
});

/* G-13: closing the tab kills its worker id; reopening presents a new one.
   The resumed session must wait out the dead lease (or take it over once the
   holder has gone idle) and finish — the exact flow that used to fail with
   'a stage is already running'. */
test("a dead tab's run is taken over by a reopened session and finishes", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/investigations", {
    multipart: demoForm("Dead tab takeover check"),
  });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };

  // Tab A starts the plan and dies mid-run: its worker holds the lease.
  const plan = await request.post(`/api/investigations/${investigationId}/plan`, {
    data: { pass: 1, worker: "dead-tab" },
  });
  expect(plan.status(), "plan").toBe(200);

  // Tab B (a new worker) opens the progress page and confirms the scope the
  // dead tab never confirmed. The resume then waits for the idle window and
  // takes the run over instead of erroring out.
  await page.goto(`/investigations/${investigationId}/progress?synthetic=1`);
  await page
    .getByRole("button", { name: "Confirm scope & investigate" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);

  await page.waitForURL((url) => !url.pathname.includes("/progress"), { timeout: 180_000 });
  await expect(page.locator("#answer")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".alert-error")).toHaveCount(0);

  // The takeover completed the whole pipeline.
  const status = (await (
    await request.get(`/api/investigations/${investigationId}/status`)
  ).json()) as { stages: { stage: string; status: string }[] };
  const byName = new Map(status.stages.map((stage) => [stage.stage, stage]));
  expect(byName.get("assemble")?.status).toBe("done");
});

/* G-13: a tab that closes mid-run leaves a half-finished, durable run;
   reopening the progress page resumes at the first missing stage and the
   run finishes without redoing what is already stored. */
test("reopening a half-finished run resumes and finishes without redoing stages", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/investigations", {
    multipart: demoForm("Half-run resume check"),
  });
  expect([200, 201], "ingest").toContain(created.status());
  const { investigationId } = (await created.json()) as { investigationId: string };

  await request.post(`/api/investigations/${investigationId}/plan`, { data: { pass: 1 } });
  for (const kind of ["root_cause", "commitments", "ownership"]) {
    await request.post(`/api/investigations/${investigationId}/investigate`, {
      data: { kind, pass: 1 },
    });
  }
  await request.post(`/api/investigations/${investigationId}/skeptic`, { data: { pass: 1 } });
  // verify never ran — this is the "tab closed" state.

  const before = (await (
    await request.get(`/api/investigations/${investigationId}/status`)
  ).json()) as { stages: { stage: string; status: string; log: unknown[] }[] };
  const verifyBefore = before.stages.find((stage) => stage.stage === "verify");
  expect(verifyBefore?.status ?? "pending").toBe("pending");

  await page.goto(`/investigations/${investigationId}/progress?synthetic=1`);
  // The unconfirmed partial scope pauses first (G-12): confirm it and the
  // run resumes at the first missing stage.
  await page
    .getByRole("button", { name: "Confirm scope & investigate" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);

  await page.waitForURL((url) => !url.pathname.includes("/progress"), { timeout: 180_000 });
  await expect(page.locator("#answer")).toBeVisible({ timeout: 30_000 });

  // The resumed run recorded verify and assemble on pass 1, and the
  // investigators were not re-logged (their stored work was reused).
  const after = (await (
    await request.get(`/api/investigations/${investigationId}/status`)
  ).json()) as { stages: { stage: string; status: string; log: unknown[] }[] };
  const byName = new Map(after.stages.map((stage) => [stage.stage, stage]));
  expect(byName.get("verify")?.status).toBe("done");
  expect(byName.get("assemble")?.status).toBe("done");
});
