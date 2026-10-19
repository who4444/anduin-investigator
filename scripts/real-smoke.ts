import { mkdirSync, readFileSync } from "node:fs";

import { chromium } from "@playwright/test";
import { zipSync } from "fflate";

/* Real end-to-end smoke: drives a RUNNING app (npm run start on :3000, real
   LLM credentials in .env.local) through the browser, runs one or more real
   scenarios, prints stage timings, and fails loudly on any error state.
   Not part of the offline Playwright suite — no fake LLM here.

   Usage: npx tsx scripts/real-smoke.ts [demo|realistic|vague|all] */

const BASE = process.env.REAL_SMOKE_BASE ?? "http://localhost:3000";
const SHOT_DIR = "test-results/real";
const scenario = (process.argv[2] ?? "all") as "demo" | "realistic" | "vague" | "all";

const DEMO_FILES = [
  "jira-meridian.json",
  "northwind-emails.mbox",
  "escalation.eml",
  "slack/users.json",
  "slack/channels.json",
  "slack/meridian-billing/messages.json",
  "slack/general/messages.json",
];

const waits = { nav: 120_000, pipeline: 15 * 60_000 };

function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function readStageRows(page: import("@playwright/test").Page): Promise<string[]> {
  return (await page.locator(".step").allInnerTexts()).map((text) => text.replace(/\n/g, " | "));
}

async function assertReport(page: import("@playwright/test").Page, label: string): Promise<void> {
  await page.locator("#answer").waitFor({ state: "visible", timeout: waits.pipeline });
  const scope = (await page.locator(".scope-line").first().innerText()).replace(/\s+/g, " ");
  const stats = (await page.locator(".hero-status").first().innerText().catch(() => "")).replace(/\s+/g, " ");
  const errors = await page.locator(".alert-error").count();
  console.log(`${label}: report OK — scope: "${scope}" · ${stats} · errors: ${errors}`);
  if (errors > 0) {
    console.log("ERROR ALERTS:", await page.locator(".alert-error").allInnerTexts());
    throw new Error(`${label}: report carries error alerts`);
  }
}

async function progressWatch(page: import("@playwright/test").Page, label: string): Promise<void> {
  // Poll the progress screen so a mid-run failure surfaces with its message.
  for (let i = 0; i < 120; i += 1) {
    const reportVisible = await page.locator("#answer").isVisible().catch(() => false);
    if (reportVisible) return;

    // G-12: a partial scope pauses before any investigator spends tokens.
    const confirmScope = page.getByRole("button", { name: "Confirm scope & investigate" });
    if (await confirmScope.isVisible().catch(() => false)) {
      console.log(`${label}: confirming the pre-run scope review`);
      await confirmScope.click().catch(() => undefined);
    }
    // G-23: a multi-issue case pauses for the editable issue review.
    const confirmIssues = page.getByRole("button", {
      name: /Confirm \d+ issues? and investigate/i,
    });
    if (await confirmIssues.isVisible().catch(() => false)) {
      console.log(`${label}: confirming the issue review`);
      await confirmIssues.click().catch(() => undefined);
    }

    const failed = await page.locator(".alert-error").allInnerTexts().catch(() => []);
    if (failed.length > 0) {
      console.log(`${label}: PROGRESS ERROR`, failed);
      await page.screenshot({ path: `${SHOT_DIR}/${label}-progress-error.png` });
      throw new Error(`${label}: pipeline failed mid-run`);
    }
    await page.waitForTimeout(3_000);
  }
  throw new Error(`${label}: pipeline did not finish in time`);
}

async function demoScenario(): Promise<void> {
  header("SCENARIO 1 — Northwind demo via the start page (real LLM)");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const startedAt = Date.now();
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "Load Northwind scenario" }).click();
  await page.getByRole("button", { name: "Investigate" }).click();
  await page.waitForURL(/\/investigations\/[0-9a-f-]+\/progress/, { timeout: waits.nav });
  await page.screenshot({ path: `${SHOT_DIR}/demo-progress-early.png` });

  await progressWatch(page, "demo");
  await assertReport(page, "demo");
  await page.screenshot({ path: `${SHOT_DIR}/demo-report.png`, fullPage: false });

  // Real timings from the review screen.
  const url = new URL(page.url());
  await page.goto(`${BASE}${url.pathname}/progress?review=1`);
  await page.locator(".step.is-done").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  console.log("stage timings:", await readStageRows(page));
  console.log(`demo scenario total wall time: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  await browser.close();
}

async function realisticScenario(): Promise<void> {
  header("SCENARIO 2 — four-tenant realistic workspace via zip upload (real LLM)");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const startedAt = Date.now();

  const manifest = JSON.parse(readFileSync("public/realistic/manifest.json", "utf8")) as { files: string[] };
  const zipInput: Record<string, Uint8Array> = {};
  for (const name of manifest.files) {
    zipInput[name] = readFileSync(`public/realistic/${name}`);
  }
  const zip = zipSync(zipInput, { level: 6 });

  await page.goto(`${BASE}/upload?fresh=1`);
  await page
    .locator("textarea")
    .first()
    .fill(
      "Real smoke: Bright Market VAT totals still wrong since 5.3.0 (LUM-811). Explain what happened.",
    );
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "realistic-workspace.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await page.getByRole("button", { name: "Investigate these exports" }).click();
  await page.waitForURL(/\/investigations\/[0-9a-f-]+\/progress/, { timeout: waits.nav });

  await progressWatch(page, "realistic");
  await assertReport(page, "realistic");
  await page.screenshot({ path: `${SHOT_DIR}/realistic-report.png` });

  const url = new URL(page.url());
  await page.goto(`${BASE}${url.pathname}/progress?review=1`);
  await page.locator(".step.is-done").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  console.log("stage timings:", await readStageRows(page));
  console.log(`realistic scenario total wall time: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  await browser.close();
}

async function vagueScenario(): Promise<void> {
  header("SCENARIO 3 — vague escalation, no declared client (real LLM, seeded via API)");
  const form = new FormData();
  for (const name of DEMO_FILES) {
    form.append("files", new File([readFileSync(`public/demo/${name}`)], name, { type: "application/octet-stream" }));
  }
  form.append(
    "escalation",
    "Everything about our billing module has been broken since the last update. Nobody replies.",
  );
  form.append("cacheBust", `real-smoke-${Date.now()}`);
  form.append("origin", "upload");
  form.append("title", "Real smoke — vague escalation");

  const created = await fetch(`${BASE}/api/investigations`, { method: "POST", body: form });
  const createdBody = (await created.json()) as { investigationId?: string; error?: string };
  if (!created.ok || !createdBody.investigationId) {
    throw new Error(`vague ingest failed: ${created.status} ${createdBody.error ?? ""}`);
  }
  const id = createdBody.investigationId;
  const startedAt = Date.now();

  const stage = async (name: string, body: Record<string, unknown> = { pass: 1 }) => {
    const response = await fetch(`${BASE}/api/investigations/${id}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`vague stage ${name} failed: ${response.status} ${await response.text()}`);
    }
  };
  await stage("plan");
  for (const kind of ["root_cause", "commitments", "ownership"]) await stage("investigate", { kind, pass: 1 });
  await stage("skeptic");
  await stage("verify");
  await stage("assemble");

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/investigations/${id}`);
  await page.locator("#answer").waitFor({ state: "visible", timeout: 60_000 });
  const scopeLine = (await page.locator(".scope-line").first().innerText()).replace(/\s+/g, " ");
  const tone = await page.locator(".scope-line").first().getAttribute("class");
  console.log(`vague scope line: "${scopeLine}" [${tone}]`);
  if (!tone?.includes("tone-none") && !tone?.includes("tone-partial")) {
    throw new Error(`vague escalation presented as confident: ${tone}`);
  }
  await page.screenshot({ path: `${SHOT_DIR}/vague-report.png` });
  console.log(`vague scenario total wall time: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  await browser.close();
}

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`No running app at ${BASE}. Start it with \`npm run start\` first.`);
  }

  if (scenario === "demo" || scenario === "all") await demoScenario();
  if (scenario === "realistic" || scenario === "all") await realisticScenario();
  if (scenario === "vague" || scenario === "all") await vagueScenario();

  console.log(`\nAll real-smoke scenarios passed. Screenshots in ${SHOT_DIR}/`);
}

void main().catch((error) => {
  console.error(`\nREAL SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
