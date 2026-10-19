import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnv } from "../../lib/db/env";
import { getPool } from "../../lib/db/pool";

import { ensureFakeLlm } from "./fake-llm";

export const SNAPSHOT_FILE = path.resolve(process.cwd(), "test-results/.ui-test-investigations.json");

/* Snapshot the investigations that exist BEFORE the run; the teardown deletes
   anything created during it, so UI specs never leak rows into the dev
   database (regardless of title). */
async function snapshotInvestigations(): Promise<void> {
  loadEnv();
  if (!process.env.DATABASE_URL) return;
  const sql = getPool();
  // The pool is shared with the teardown (same Playwright process): never end
  // it here or the teardown's queries hit a dead connection.
  const rows = await sql<{ id: string }[]>`select id from investigations`;
  mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(rows.map((row) => row.id)));
}

export default async function globalSetup(): Promise<void> {
  await ensureFakeLlm();
  await snapshotInvestigations();
}
