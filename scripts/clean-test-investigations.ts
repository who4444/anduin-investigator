/* Remove investigations created by the UI/DB test suites.

   Test seeds intentionally use short titles ("Scope " + escalation.slice(24),
   "Robustness …") and HTTP-created runs are never deleted, so a long-lived
   local database accumulates hundreds of junk rows in "Recent investigations".
   This script deletes ONLY:
     - rows whose title matches the known test prefixes;
     - rows whose title carries a raw test UUID;
     - older duplicates of run-derived titles ("MER-87: Issue created: …")
       produced by repeated test/eval runs, keeping the newest of each.
   Eval/real runs ("Review run — …", scenario titles) are left untouched.

   Usage:
     npx tsx scripts/clean-test-investigations.ts           # dry run
     npx tsx scripts/clean-test-investigations.ts --apply   # delete
*/
import { loadEnv } from "../lib/db/env";
import { getPool } from "../lib/db/pool";
import { deleteInvestigation } from "../lib/store";

/* Keep in sync with tests/ui/global-teardown.ts. */
export const TEST_TITLE_PATTERN =
  /^(Robustness |Scope |Tools |Commitments |Learn |Routes |Upload |Recent list|Multi-issue |Fixture meta refresh|UI redesign|UI harness scenario|Long client message sample|Candidate engagements sample|Realistic workspace — Bright Market|MER-101: Issue created: Timezone totals wrong)/;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const DERIVED_TITLE = /^[A-Z][A-Z0-9]{1,9}-\d+: Issue created:/;

async function main(): Promise<void> {
  loadEnv();
  const apply = process.argv.includes("--apply");
  const sql = getPool();
  const rows = await sql<{ id: string; title: string; created_at: string }[]>`
    select id, title, created_at from investigations order by created_at desc
  `;

  const seeded = rows.filter((row) => TEST_TITLE_PATTERN.test(row.title));
  const uuidTitled = rows.filter(
    (row) => !seeded.includes(row) && UUID.test(row.title),
  );
  const seenDerived = new Set<string>();
  const duplicateDerived: { id: string; title: string; created_at: string }[] = [];
  for (const row of rows) {
    if (!DERIVED_TITLE.test(row.title)) continue;
    if (seenDerived.has(row.title)) duplicateDerived.push(row);
    else seenDerived.add(row.title);
  }
  const doomed = [...new Set<{ id: string; title: string; created_at: string }>([...seeded, ...uuidTitled, ...duplicateDerived])];

  console.log(`investigations: ${rows.length} total`);
  console.log(`  test seeds:              ${seeded.length}`);
  console.log(`  test UUID titles:        ${uuidTitled.length}`);
  console.log(`  duplicate derived runs:  ${duplicateDerived.length}`);
  console.log(`to delete: ${doomed.length}`);
  for (const row of doomed.slice(0, 12)) console.log(`  - ${row.title.slice(0, 70)}`);
  if (doomed.length > 12) console.log(`  … and ${doomed.length - 12} more`);
  if (!apply) {
    console.log("\nDry run — re-run with --apply to delete these.");
    process.exit(0);
  }
  for (const row of doomed) {
    await deleteInvestigation(row.id);
  }
  console.log(`\nDeleted ${doomed.length} test-created/duplicate investigations.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
