import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { loadEnv } from "../../lib/db/env";

loadEnv();

/* The 3-record sample from the revision brief: one Jira creation, one status
   change, one client email, no Slack and no client identity. The report must
   tell the story, state its limits, and show the unresolved client action. */

let investigationId = "";
let longMessageId = "";

const LONG_TAIL = "finance keeps re-running the exports by hand every morning";
const LONG_ESCALATION =
  "Totals are wrong since 4.12. The bill shows the wrong day in every line item, " +
  "our reconciliation is off by one day across the board, and " + LONG_TAIL + ".";

const sentences = (text: string): string[] =>
  text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.split(" ").length >= 8);

async function bodyText(page: Page): Promise<string> {
  return page.locator("body").innerText();
}

test.beforeAll(async () => {
  const { createInvestigation, insertEvents, upsertStage } = await import("../../lib/store");
  investigationId = await createInvestigation({
    title: "MER-101: Issue created: Timezone totals wrong 8d1a3d0e-1111-2222-3333-444455556666",
    escalationText: "Client says totals are wrong since 4.12.",
    contentHash: `model-sample-${randomUUID()}`,
    origin: "upload",
  });
  await insertEvents(investigationId, [
    {
      id: "e_model_1",
      source: "jira",
      ts: "2024-09-10T03:00:00.000Z",
      actor: "Priya Nair",
      channel: "MER-101",
      text: "Issue created: Timezone totals wrong 8d1a3d0e-1111-2222-3333-444455556666",
    },
    {
      id: "e_model_2",
      source: "jira",
      ts: "2024-09-10T04:00:00.000Z",
      actor: "Lin Chen",
      channel: "MER-101",
      text: "Status: Open → In Progress",
    },
    {
      id: "e_model_3",
      source: "email",
      ts: "2024-09-24T01:30:00.000Z",
      actor: "Priya Nair <priya@northwind.example>",
      channel: "email",
      text: "Totals are still wrong after the 4.12 release for every single client in our region.",
    },
  ]);
  await upsertStage(investigationId, "ingest", 1, "done");

  const { createInvestigation: createLong, insertEvents: insertLongEvents, upsertStage: upsertLongStage } =
    await import("../../lib/store");
  longMessageId = await createLong({
    title: "Long client message sample",
    escalationText: LONG_ESCALATION,
    contentHash: `model-long-${randomUUID()}`,
    origin: "upload",
  });
  await insertLongEvents(longMessageId, [
    {
      id: "e_long_1",
      source: "jira",
      ts: "2024-09-11T03:00:00.000Z",
      actor: "Priya Nair",
      channel: "MER-102",
      text: "Issue created: Totals wrong after the 4.12 release.",
    },
  ]);
  await upsertLongStage(longMessageId, "ingest", 1, "done");
});

test.afterAll(async () => {
  const { deleteInvestigation } = await import("../../lib/store");
  if (investigationId) await deleteInvestigation(investigationId);
  if (longMessageId) await deleteInvestigation(longMessageId);
});

test("a long client message keeps a see more preview that expands in place", async ({ page }) => {
  await page.goto(`/investigations/${longMessageId}`);

  const details = page.locator("details.client-says");
  await expect(details).toBeVisible();
  const summary = details.locator("summary");
  await expect(summary).toContainText("see more");
  expect(await summary.innerText()).not.toContain(LONG_TAIL);

  await summary.click();
  await expect(details.locator("blockquote.client-says-full")).toContainText(LONG_TAIL);
  await expect(details.locator(".see-more")).toBeHidden();
});

test("the 3-record sample tells the story, states its limits and confirms the client", async ({
  page,
}) => {
  await page.goto(`/investigations/${investigationId}`);

  // Title cleanup: no ticket prefix, no "Issue created:", no UUID.
  const title = await page.locator(".report-title").innerText();
  expect(title).toBe("Timezone totals wrong");
  expect(title).not.toMatch(/MER-101|Issue created|8d1a3d0e-/);

  // The unresolved client is a prominent, actionable notice before roles.
  const notice = page.locator(".client-resolution");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Client and project not confirmed");
  await expect(notice.getByLabel("Client roster")).toBeVisible();
  await expect(notice.getByRole("button", { name: "Confirm client" })).toBeVisible();
  await expect(page.locator(".scope-line.tone-none")).toContainText(
    "No client or project could be identified",
  );

  // Counts equal the lists they summarize.
  await expect(page.locator(".scoreboard-cell")).toHaveCount(5);
  await expect(page.locator(".scoreboard-cell").filter({ hasText: "Findings" })).toContainText("3");
  await expect(page.locator(".event-row")).toHaveCount(3);
  await expect(page.locator(".question-group:visible")).toHaveCount(5);
  await expect(page.locator(".question-group").first()).toContainText("Next step:");
  // The header count includes the group behind the collapsed Show all control.
  await expect(page.locator("#gaps .count-chip")).toHaveText("6");
  await expect(page.getByText("Show all (6)")).toBeVisible();
  await expect(page.locator(".scope-flag")).toHaveCount(0);

  // Role-dependent state is explicit, not guessed.
  const state = await page.locator(".now-block").innerText();
  expect(state).toContain("Needs client confirmation — the client is not identified.");
  expect(state).toContain("Needs client confirmation — client vs internal roles are unresolved.");
  await expect(page.locator(".now-block")).toContainText("No assignee transition is recorded.");

  // One finding, one full sentence; the headline is a story with citations.
  const text = await bodyText(page);
  const repeated = new Map<string, number>();
  for (const sentence of sentences(text)) repeated.set(sentence, (repeated.get(sentence) ?? 0) + 1);
  expect([...repeated.values()].filter((count) => count > 1)).toEqual([]);
  expect(await page.locator(".verdict .citation").count()).toBeGreaterThanOrEqual(2);
  expect(await page.locator(".verdict").innerText()).toContain("Only 3 records were found");

  // The action is named after its triggering finding, not the draft reply.
  await expect(page.locator("#actions")).toContainText("trigger f2");
  await expect(page.locator("#actions")).not.toContainText(/draft reply/i);

  // Truncated labels offer "see more"; the drawer then leads with the full
  // sentence in bold while the record below stays unchanged.
  const truncatedLink = page.locator(".finding-link", { hasText: "see more" }).first();
  await expect(truncatedLink).toBeVisible();
  const shortText = (await truncatedLink.innerText()).replace(/\s*see more\s*$/i, "").trim();
  expect(shortText.endsWith("…")).toBe(true);
  await truncatedLink.click();
  const drawer = page.locator("aside.drawer").last();
  const heading = drawer.locator(".drawer-heading");
  await expect(heading).toBeVisible();
  const fullText = (await heading.innerText()).replace(/\s+/g, " ").trim();
  expect(fullText).not.toContain("…");
  expect(fullText.startsWith(shortText.replace(/…$/, "").trim())).toBe(true);
  const firstClass = await drawer.locator(":scope > *").first().getAttribute("class");
  expect(firstClass ?? "").toContain("drawer-heading");
  const weight = await heading.evaluate((el) => getComputedStyle(el).fontWeight);
  expect(Number(weight)).toBeGreaterThanOrEqual(600);
  await expect(drawer.locator("p.evidence")).toBeVisible();
  await page.getByLabel("Close evidence").click();

  // The Do-now action label opens the drawer of the finding it names.
  const actionLink = page.locator("#actions button.action-text").first();
  await expect(actionLink).toBeVisible();
  await actionLink.click();
  await expect(page.locator("aside.drawer .drawer-heading")).toBeVisible();
  await page.getByLabel("Close evidence").click();

  // A short client message is shown in full — no click required.
  const clientSays = page.locator(".client-says");
  await expect(clientSays).toContainText("The client says");
  await expect(clientSays).toContainText("Client says totals are wrong since 4.12.");
  await expect(page.locator("details.client-says")).toHaveCount(0);

  // The confirm action resolves the client identity in place.
  await notice.getByLabel("Client roster").fill("Northwind Logistics");
  await notice.getByLabel("Project").fill("Meridian");
  await notice.getByRole("button", { name: "Confirm client" }).click();
  await expect(page.locator(".scope-line")).toContainText("Northwind Logistics");
  await expect(page.locator(".scope-line")).toContainText("Scope confirmed by you");
  await expect(page.locator(".client-resolution")).toHaveCount(0);
  await expect(page.locator(".now-block")).toContainText("Priya Nair");
});
