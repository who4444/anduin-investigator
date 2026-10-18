import { expect, test } from "@playwright/test";

/* Full user journey: start page → built-in scenario → progress → report. */

test("the built-in scenario runs end to end and lands on the answer-first report", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Load Northwind scenario" }).click();
  await page.getByRole("button", { name: "Investigate" }).click();

  await page.waitForURL(/\/investigations\//, { timeout: 60_000 });

  // G-12: the partially-confirmed scope pauses for a quick confirmation
  // before investigators spend any tokens.
  await page
    .getByRole("button", { name: "Confirm scope & investigate" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);

  // The pipeline runs on the progress screen; its finish redirect lands on the
  // report where the answer layer is the first section.
  await expect(page.locator("#answer")).toBeVisible({ timeout: 180_000 });

  // The answer comes first: scoreboard, verdict context and actions.
  await expect(page.locator("#answer")).toBeVisible();
  // A cached investigation keeps the scope resolved by the run that created
  // it (a real-LLM smoke run may resolve differently), so assert only the
  // invariant — the declared client. Scope resolution itself is covered by
  // scope.spec.ts on fresh runs.
  await expect(page.locator(".scope-line")).toContainText("Northwind Logistics");
  await expect(page.locator(".scoreboard-cell")).toHaveCount(5);
  await expect(page.locator(".client-says")).toContainText("The client says");
  await expect(page.locator(".do-now .action-card").first()).toBeVisible();

  // Sections are named as the business questions.
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What was promised?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What went wrong?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What could not be determined?" })).toBeVisible();

  // Event rows carry quiet source labels, not boxed source chips.
  await expect(page.locator(".event-row .source-label").first()).toBeVisible();
  await expect(
    page.locator(".event-row .chip-source-jira, .event-row .chip-source-slack, .event-row .chip-source-email"),
  ).toHaveCount(0);
});
