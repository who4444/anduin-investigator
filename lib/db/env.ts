import { existsSync } from "node:fs";
import path from "node:path";

type ProcessWithLoadEnv = NodeJS.Process & {
  loadEnvFile?: (file?: string) => void;
};

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  if (process.env.DATABASE_URL) return;

  const file = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return;

  try {
    (process as ProcessWithLoadEnv).loadEnvFile?.(file);
  } catch {
    // Ignore: a malformed or unreadable env file should not crash callers.
  }
}
