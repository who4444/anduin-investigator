import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { loadEnv } from "./env";
import { getPool } from "./pool";

async function main(): Promise<void> {
  loadEnv();
  const sql = getPool();

  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const migrationsDir = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  // postgres.js returns this row shape; version is a string column.
  const appliedRows = await sql<{ version: string }[]>`select version from schema_migrations`;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) {
      continue;
    }

    const contents = await readFile(path.join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`insert into schema_migrations (version) values (${version})`;
    });
    console.log(`applied ${file}`);
  }

  console.log("migrations up to date");
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
