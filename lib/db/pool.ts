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
    pool = postgres(url, {
      max: Number(process.env.DATABASE_POOL_MAX ?? "5"),
      prepare: process.env.DATABASE_PREPARE === "true",
      onnotice: () => {},
    });
  }
  return pool;
}
