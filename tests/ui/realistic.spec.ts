import { readFileSync } from "node:fs";

import { expect, test, type APIRequestContext } from "@playwright/test";

/* The realistic scattered-data workspace driven through the full pipeline
   offline: the target engagement must come out scoped, with every cited
   record inside its scope, at realistic volume. */

const FILES = JSON.parse(readFileSync("public/realistic/manifest.json", "utf8")) as { files: string[] };

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
  for (const name of FILES.files) {
    const mime = name.endsWith(".eml") ? "message/rfc822" : name.endsWith(".mbox") ? "application/mbox" : "application/json";
    form.append("files", new File([readFileSync(`public/realistic/${name}`)], name, { type: mime }));
  }
  // A run-unique escalation keeps the seed fresh so the pipeline re-runs after
  // identity/scoping code changes (the old cached rows predate them).
  const stamp = Number(process.env.REALISTIC_RUN ?? Date.now());
  form.append("escalation", `Bright Market's VAT invoice exports have shown blank totals since the 5.3.0 upgrade four weeks ago (ticket LUM-811). We were promised the Sep 20 release; our chases went unanswered. Explain what happened and when this was actually fixed. [run ${stamp}]`);
  form.append("client", "Bright Market");
  form.append("origin", "demo");
  form.append("title", "Realistic workspace — Bright Market / Lumen Ledger VAT exports");

  // 201 = freshly ingested; 200 = a previous run left this exact seed cached
  // (same escalation, same bytes, assemble already done).
  const created = await request.post("/api/investigations", { multipart: form });
  expect([200, 201], "ingest").toContain(created.status());
  const ingest = (await created.json()) as { investigationId: string };
  // Volume is asserted on the result payload: the cached path reports 0 here.

  await runStage(request, ingest.investigationId, "plan", { pass: 1 });
  for (const kind of ["root_cause", "commitments", "ownership"]) {
    await runStage(request, ingest.investigationId, "investigate", { kind, pass: 1 });
  }
  await runStage(request, ingest.investigationId, "skeptic", { pass: 1 });
  await runStage(request, ingest.investigationId, "verify", { pass: 1 });
  await runStage(request, ingest.investigationId, "assemble", { pass: 1 });

  reportUrl = `/investigations/${ingest.investigationId}?synthetic=1`;
});

test("a realistic four-tenant workspace lands scoped to the escalation's engagement", async ({ page }) => {
  await page.goto(reportUrl);

  await expect(page.locator(".scope-line.tone-scoped")).toContainText("Bright Market");
  await expect(page.locator(".scope-line")).toContainText("excluded");

  // The five answers are all determined at this volume.
  const cells = await page.locator(".scoreboard-cell").all();
  expect(cells.length).toBe(5);
  for (const cell of cells) {
    await expect(cell).not.toContainText("not determined");
  }
});

test("retrieval stays inside the scoped engagement at volume", async ({ request }) => {
  const response = await request.get(reportUrl.replace("/investigations/", "/api/investigations/").replace("?synthetic=1", "/result"));
  const result = (await response.json()) as {
    scope?: { excludedRecords: number; excludedClaims: number; channels: string[]; ticketPrefixes: string[] };
    claims?: { eventId: string; text: string }[];
    timeline?: { id: string; channel: string }[];
    bottomLine?: { cells: { id: string; determined: boolean }[] };
  };

  expect(result.scope).toBeDefined();
  expect(result.scope!.excludedRecords).toBeGreaterThan(80);
  expect(result.scope!.ticketPrefixes).toContain("LUM");
  expect(result.scope!.channels).toContain("lumen-general");
  // G-01: the client's shared room is client evidence even without an email
  // address on the Slack account.
  expect(result.timeline?.some((event) => event.channel === "general")).toBe(true);

  // Every event in the report view belongs to the scoped engagement: jira
  // channels carry the ticket key, slack carries the scoped room, and email
  // rows are scope-matched by sender domain (channel is always "email").
  expect(result.timeline?.length ?? 0).toBeGreaterThanOrEqual(15);
  for (const event of result.timeline ?? []) {
    expect(`${event.channel}`).toMatch(/^LUM-|lumen|^email$|^general$/);
  }
  // Every cited record exists inside the report set (no fabricated sources).
  const eventIds = new Set((result.timeline ?? []).map((event) => event.id));
  for (const claim of result.claims ?? []) {
    expect(eventIds.has(claim.eventId), claim.text).toBe(true);
  }

  for (const cell of result.bottomLine?.cells ?? []) {
    expect(cell.determined, cell.id).toBe(true);
  }
});

test("the excluded-records review adds a record back and re-runs the investigation", async ({ page }) => {
  await page.goto(reportUrl);
  await expect(page.locator("#gaps")).toBeVisible();

  // Open the excluded list and add the first record back.
  const panel = page.locator(".excluded-panel");
  await panel.locator("summary").click();
  const first = panel.locator(".excluded-row input[type=checkbox]").first();
  await first.check();
  await panel.getByRole("button", { name: "Re-run with 1 record included" }).click();

  // The re-run streams on the progress page and lands back on the report…
  await page.waitForURL(/\/progress\?rerun=1/, { timeout: 30_000 });
  await page.waitForURL((url) => !url.pathname.includes("/progress"), { timeout: 180_000 });

  // …where the reviewed record is disclosed as added back into scope.
  await expect(page.locator(".scope-line")).toContainText("1 reviewed record added back into scope");
});
