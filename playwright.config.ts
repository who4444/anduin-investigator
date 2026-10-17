import { defineConfig } from "@playwright/test";

/* UI tests drive the real built app with a deterministic fake LLM endpoint.
   Build first (`npm run build`), then `npm run test:ui`. */

export default defineConfig({
  testDir: "tests/ui",
  timeout: 120_000,
  workers: 1,
  globalSetup: "./tests/ui/global-setup.ts",
  globalTeardown: "./tests/ui/global-teardown.ts",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
  },
  webServer: {
    command: "npm run start",
    port: 3100,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: "3100",
      DEEPSEEK_BASE_URL: "http://127.0.0.1:9401",
      DEEPSEEK_MODEL: "fake-model",
    },
  },
});
