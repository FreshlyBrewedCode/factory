import { expect, test } from "@playwright/test";

/**
 * Issue #65 (ADR 0013 §5): run detail shows what an ACP agent reported —
 * context against the window and cost per step, the run's summed cost, and
 * the descriptive tool title in the transcript. Seeded as `run-static-acp`
 * by `e2e/server.ts`; the live context fold is covered by `run-events.test.ts`.
 */
test("run detail shows context, cost and tool titles for an ACP run", async ({ page }) => {
  await page.goto("/runs/run-static-acp");

  // Run cost: both steps, the cancelled one included ($0.039 + $0.028).
  await expect(page.getByTestId("run-cost")).toHaveText("$0.067");

  const implement = page
    .locator('[data-testid="step-row"][data-kind="agent"]')
    .filter({ hasText: "implement" });
  await expect(implement.getByTestId("step-meta")).toHaveText(/15\.3k\/200k ctx · \$0\.039/);
  const review = page
    .locator('[data-testid="step-row"][data-kind="agent"]')
    .filter({ hasText: "review" });
  await expect(review).toHaveAttribute("data-status", "cancelled");
  await expect(review.getByTestId("step-meta")).toHaveText(/9\.1k\/200k ctx · \$0\.028/);

  await implement.click();
  await expect(page.getByTestId("step-context")).toContainText("15.3k / 200k · 8%");
  await expect(page.getByTestId("step-context-meter")).toHaveAttribute("data-share", "0.077");
  await expect(page.getByTestId("step-cost")).toHaveText("$0.039");

  await page.getByTestId("open-transcript").click();
  const tool = page.getByTestId("transcript-tool");
  await expect(tool).toHaveCount(1);
  await expect(tool).toContainText("Edit math.ts");
  await expect(tool).toContainText("edit · complete");
});

test("an old opencode log falls back to the derived context, without cost", async ({ page }) => {
  await page.goto("/runs/run-static-corpus");
  await expect(page.getByTestId("run-meta")).toContainText("cost");
  await expect(page.getByTestId("run-cost")).toHaveCount(0);
  const implement = page
    .locator('[data-testid="step-row"][data-kind="agent"]')
    .filter({ hasText: "implement" })
    .first();
  await expect(implement.getByTestId("step-meta")).toHaveText(/\d+(\.\d)?k ctx$/);
  await implement.click();
  await expect(page.getByTestId("step-context")).toContainText("(final turn)");
  await expect(page.getByTestId("step-context-meter")).toHaveCount(0);
});
