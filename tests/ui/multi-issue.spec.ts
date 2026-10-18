import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

/* G-23: an escalation with two independent issues must pause before the
   expensive investigation, let the manager confirm the split, then keep the
   findings, promises and reply separated per issue in the report. */

const FILES = JSON.parse(readFileSync("public/multi/manifest.json", "utf8")) as {
  files: string[];
};

const ESCALATION =
  "Contoso has two independent issues. First, VAT invoice totals have been blank since the 2.1.0 upgrade; the fix was promised for the Sep 20 release and the ticket was closed while the totals were still blank. Second, finance users cannot sign in since the identity migration; the SSO fix was promised for the Sep 26 release and still fails. Our chases on 22 and 23 September went unanswered. Explain what happened on each issue and when each will actually be fixed.";

test("multi-issue escalation pauses for an editable issue review, then reports per issue", async ({
  page,
}) => {
  const zip = zipSync(
    Object.fromEntries(
      FILES.files.map((name) => [name, new Uint8Array(readFileSync(`public/multi/${name}`))]),
    ),
  );

  await page.goto("/upload");
  await page.locator("textarea").first().fill(ESCALATION);
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "multi-issue.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByRole("button", { name: "Investigate these exports" }).click();
  await page.waitForURL(/\/investigations\/[0-9a-f-]+\/progress/, { timeout: 60_000 });

  // G-12: a partial scope pauses first; confirm it, then the issue review
  // (or the issue review directly, when the scope came back scoped).
  const scopeContinue = page.getByRole("button", { name: "Confirm scope & investigate" });
  await Promise.race([
    page.locator(".issue-review").waitFor({ state: "visible", timeout: 120_000 }),
    scopeContinue
      .waitFor({ state: "visible", timeout: 120_000 })
      .then(() => scopeContinue.click()),
  ]);

  // The plan runs, then the pipeline pauses before any investigator call.
  await expect(page.locator(".issue-review")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".issue-edit-card")).toHaveCount(2);
  await expect(page.locator(".issue-review")).toContainText("Confirm the issues before I investigate");

  // A reload while the review is open must show the same review (not re-plan
  // or skip the manager's confirmation) and resume on the same paused lease.
  await page.reload();
  await expect(page.locator(".issue-review")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".issue-edit-card")).toHaveCount(2);

  // Editable: rename the first issue, then confirm both.
  const firstTitle = page.locator(".issue-edit-card input").first();
  await firstTitle.fill("VAT totals blank after 2.1.0 (confirmed)");
  await page.getByRole("button", { name: /Confirm 2 issues and investigate/ }).click();

  await page.waitForURL(/\/investigations\/[0-9a-f-]+(\?|$)/, { timeout: 180_000 });
  await expect(page.locator(".issue-index")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".issue-index a")).toHaveCount(3); // All + two issues
  await expect(page.locator(".issue-heading")).toContainText("Issue 1 of 2");
  await expect(page.locator(".issue-heading")).toContainText("VAT totals blank after 2.1.0 (confirmed)");

  // Per-issue detail: findings are scoped to the selected issue.
  await page.locator(".issue-index a").nth(2).click();
  await expect(page.locator(".issue-heading")).toContainText("Issue 2 of 2");
  await expect(page.locator(".issue-heading")).toContainText("SSO login fails");

  // The combined view keeps both issues and refuses a mixed reply.
  await page.locator(".issue-index a").first().click();
  await expect(page.locator(".issue-heading")).toContainText("All issues");
  await expect(page.locator(".issue-overview .issue-card")).toHaveCount(2);
});
