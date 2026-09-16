import { expect, test } from "@playwright/test";

/**
 * The schedules page (issue #17), against a real daemon whose config actually
 * carries one schedule: the page is read-only — id, workflow, cron and
 * timezone, the next fire computed from the stored cron, the last run's
 * outcome (never fired, fresh daemon), and a manual "Run now" that starts the
 * schedule's workflow with its configured input and navigates to it.
 */
test("the schedules page lists the config's schedule with its next fire", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Schedules" }).click();

  await expect(page).toHaveURL(/\/schedules$/);
  await expect(page.getByTestId("schedules-page")).toBeVisible();

  const row = page.getByTestId("schedule-row-e2e-nightly");
  await expect(row).toBeVisible();
  await expect(row).toContainText("registry-test");
  await expect(row).toContainText("30 4 1 1 *");
  await expect(row).toContainText("UTC");
  await expect(row).toContainText("never fired");

  // Next fire: the absolute cell renders an Intl pattern like "01 Jan",
  // then the relative sibling like "in 2h 5m".
  const next = page.getByTestId("schedule-next-e2e-nightly");
  await expect(next).toContainText(/\d{2}.*, \d{2}:\d{2}/);
  await expect(next).toContainText(/in \d/);
});

test("Run now starts the schedule's run with its configured input and navigates to it", async ({
  page,
}) => {
  await page.goto("/schedules");

  await page.getByTestId("schedule-run-now-e2e-nightly").click();

  await expect(page).toHaveURL(/\/runs\/run-/);
  const runId = page.url().split("/").at(-1)!;
  const summary = (await (await page.request.get(`/api/runs/${runId}`)).json()) as {
    readonly workflowId: string;
    readonly scheduleId: string | undefined;
    readonly input: { readonly issueNumber: number };
  };
  expect(summary.workflowId).toBe("registry-test");
  expect(summary.scheduleId).toBe("e2e-nightly");
  expect(summary.input.issueNumber).toBe(3);

  // The agent step streams over the slow fake adapter, like the New-run leg,
  // and finishes — which also releases the schedule's dedupe key for the
  // collision test that follows.
  await expect(page.getByTestId("run-meta")).toContainText(/finished/i, { timeout: 20_000 });
});

test("a manual trigger that collides shows the conflict as a visible error", async ({ page }) => {
  // Hold the schedule's dedupe key from the outside (#15's generic mechanism),
  // exactly as a scheduled run of e2e-nightly would.
  const res = await page.request.post("/api/runs", {
    data: { workflowId: "slow-test", input: {}, dedupeKey: "schedule:e2e-nightly" },
  });
  const { runId: holderRunId } = (await res.json()) as { runId: string };
  expect(res.status()).toBe(201);

  await page.goto("/schedules");
  await page.getByTestId("schedule-run-now-e2e-nightly").click();

  const error = page.getByTestId("schedule-error-e2e-nightly");
  await expect(error).toBeVisible();
  await expect(error).toContainText("schedule:e2e-nightly");
  await expect(error).toContainText(holderRunId.slice(-8));
  await expect(page).not.toHaveURL(/\/runs\//);

  // The slow workflow runs a `sleep` exec the phase-3 cancel route can stop,
  // so the test does not wait for the holder.
  const cancelled = await page.request.post(`/api/runs/${holderRunId}/cancel`);
  expect(cancelled.status()).toBe(200);
});
