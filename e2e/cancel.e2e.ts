import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * P4's cancel legs: `POST /api/runs/:id/cancel` wired into run detail and the
 * running rows of the runs list, against a real daemon (slow-exec fixture run
 * started through D31's `{workflowId, input}`). Two clicks confirm — the same
 * armed/confirm pattern on both surfaces.
 */

async function startSlowRun(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/runs", {
    data: { workflowId: "slow-test", input: {} },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { runId: string }).runId;
}

test("a running run can be cancelled from its detail page", async ({ page, request }) => {
  const runId = await startSlowRun(request);

  await page.goto(`/runs/${runId}`);
  await expect(
    page.locator('[data-testid="step-row"][data-kind="exec"][data-status="running"]').first(),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("cancel-run").click();
  await page.getByTestId("confirm-cancel").click();

  // The SSE terminal event drives the status cell; the store follows it.
  await expect(page.getByTestId("run-meta")).toContainText(/cancelled/i, { timeout: 15_000 });

  const summary = (await (await request.get(`/api/runs/${runId}`)).json()) as {
    readonly status: string;
    readonly active: boolean;
  };
  expect(summary.status).toBe("RunCancelled");
});

test("a running row can be cancelled from the runs list", async ({ page, request }) => {
  const runId = await startSlowRun(request);

  await page.goto("/");
  const row = page.getByTestId(`run-row-${runId}`);
  await expect(row).toHaveAttribute("data-status", "running", { timeout: 10_000 });

  await row.getByTestId("cancel-run").click();
  await row.getByTestId("confirm-cancel").click();

  await expect(row).toHaveAttribute("data-status", "cancelled", { timeout: 15_000 });
  const summary = (await (await request.get(`/api/runs/${runId}`)).json()) as {
    readonly status: string;
  };
  expect(summary.status).toBe("RunCancelled");
});
