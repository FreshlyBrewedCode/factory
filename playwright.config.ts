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
    // Finding 7's review viewport; wide enough for the run detail's steps +
    // details two-pane layout.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun e2e/server.ts`,
    url: `${BASE_URL}/api/runs`,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 60_000,
  },
});
