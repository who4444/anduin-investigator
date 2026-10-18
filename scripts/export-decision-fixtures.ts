/* Export recorded investigations into deterministic decision-layer fixtures
   (docs/decision-layer-plan.md §12.1). Regression data for the report invariants
   — answer keys stay in the README, never in app runtime.
   Usage: npx tsx scripts/export-decision-fixtures.ts --id <uuid> --name <scenario> ... */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnv } from "../lib/db/env";
import {
  getClaims,
  getCommitments,
  getEvents,
  getGaps,
  getInvestigation,
  getIssues,
  getSkepticNotes,
  getStages,
} from "../lib/store";

interface ExportArgs {
  id: string;
  name: string;
}

function parseArgs(argv: string[]): ExportArgs[] {
  const pairs: ExportArgs[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--id" && argv[i + 2] === "--name") {
      pairs.push({ id: argv[i + 1], name: argv[i + 3] });
      i += 3;
    }
  }
  if (pairs.length === 0) {
    console.error("usage: export-decision-fixtures.ts --id <uuid> --name <scenario> [...]");
    process.exit(2);
  }
  return pairs;
}

async function main(): Promise<void> {
  loadEnv();
  const pairs = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(process.cwd(), "tests/fixtures/decision");
  mkdirSync(outDir, { recursive: true });

  for (const { id, name } of pairs) {
    const investigation = await getInvestigation(id);
    if (!investigation) {
      console.error(`investigation ${id} not found`);
      process.exit(1);
    }
    const [events, claims, commitments, gaps, skepticNotes, stages, issues] = await Promise.all([
      getEvents(id),
      getClaims(id),
      getCommitments(id),
      getGaps(id),
      getSkepticNotes(id),
      getStages(id),
      getIssues(id),
    ]);
    const fixture = {
      investigationId: id,
      scenario: name,
      title: investigation.title,
      declaredClient: investigation.declaredClient,
      scope: investigation.scope,
      scopeOverrides: investigation.scopeOverrides,
      events,
      claims,
      commitments,
      gaps,
      skepticNotes,
      stages,
      issues,
    };
    const file = path.join(outDir, `${name}.json`);
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`${name}: ${events.length} events, ${claims.length} claims -> ${file}`);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
