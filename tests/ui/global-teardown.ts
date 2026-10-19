import { existsSync, readFileSync, rmSync } from "node:fs";

import { loadEnv } from "../../lib/db/env";
import { getPool } from "../../lib/db/pool";

import { stopFakeLlm } from "./fake-llm";

const SNAPSHOT_FILE = "test-results/.ui-test-investigations.json";

/* Backup cleanup for rows leaked by earlier crashed runs; the snapshot diff
   below is the primary guard. Keep in sync with
   scripts/clean-test-investigations.ts. */
const TEST_TITLE_PATTERN =
  /^(Robustness |Scope |Tools |Commitments |Learn |Routes |Upload |Recent list|Multi-issue |Fixture meta refresh|UI redesign|UI harness scenario|Long client message sample|Candidate engagements sample|Realistic workspace — Bright Market|MER-101: Issue created: Timezone totals wrong)/;

/* UI specs create investigations through the HTTP API; without cleanup they
   accumulate in the dev database and crowd "Recent investigations". Delete
   every investigation that did not exist when the run started (the snapshot
   from global-setup), plus any leftover rows matching the known test seeds. */
async function cleanupTestInvestigations(): Promise<void> {
  loadEnv();
  if (!process.env.DATABASE_URL) return;
  const sql = getPool();
  try {
    const snapshotExists = existsSync(SNAPSHOT_FILE);
    const before = new Set<string>(
      snapshotExists ? (JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as string[]) : [],
    );
    const rows = await sql<{ id: string; title: string }[]>`select id, title from investigations`;
    // Without a snapshot, only delete known test titles — never guess.
    const doomed = rows.filter(
      (row) => (snapshotExists && !before.has(row.id)) || TEST_TITLE_PATTERN.test(row.title),
    );
    for (const row of doomed) {
      await sql`delete from investigations where id = ${row.id}`;
    }
    if (doomed.length > 0) {
      console.log(`[ui teardown] removed ${doomed.length} test-created investigations`);
    }
  } finally {
    await sql.end();
    if (existsSync(SNAPSHOT_FILE)) rmSync(SNAPSHOT_FILE);
  }
}

export default async function globalTeardown(): Promise<void> {
  stopFakeLlm();
  await cleanupTestInvestigations().catch((error) => {
    console.error("[ui teardown] cleanup failed:", error);
  });
}
