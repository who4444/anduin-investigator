import postgres from "postgres";

import { loadEnv } from "./env";

let pool: postgres.Sql | undefined;

export function getPool(): postgres.Sql {
  if (!pool) {
    loadEnv();
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = postgres(url, { max: 10, onnotice: () => {} });
  }
  return pool;
}
