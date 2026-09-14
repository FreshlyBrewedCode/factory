import { defineConfig, devices } from "@playwright/test";

/**
 * S2's first playwright wiring. The suite is deliberately separate from
 * `bun test` (files end `.e2e.ts`, and `testMatch` claims only those), because
 * Playwright drives a *real* daemon and a real browser, while `bun test` stays
 * the fast in-process suite. The webServer is the real `factory serve` CLI on a
 * temp sqlite db — nothing here mocks `fetch`.
 *
 * Run through the Nix dev shell so Chromium's shared libs are on
 * `LD_LIBRARY_PATH` (AGENTS.md): `nix develop --command bun run test:e2e`.
 */
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun src/cli.ts serve --db .factory/e2e/factory.db --port ${PORT}`,
    url: `${BASE_URL}/api/runs`,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 30_000,
  },
});
