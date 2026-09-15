import { expect, test } from "@playwright/test";

/**
 * P4's dialog legs, matching the S3/S4 precedent: a real daemon (registry
 * workflows + workspace allocation over real sqlite) driven from the browser.
 * The dialog starts a registry workflow through D31's `POST /api/runs
 * {workflowId, input}`, and anything the D33 form cannot render falls back to
 * raw JSON with the server's decode error shown inline (400-shaped).
 */

test("the New-run dialog lists the registry, fills the input form, and starts a run", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("new-run-trigger").click();
  const dialog = page.getByTestId("new-run-dialog");
  await expect(dialog).toBeVisible();

  // Registry comes from GET /api/workflows; both fixtures are listed.
  await page.getByTestId("new-run-workflow").selectOption("registry-test");
  const field = page.getByTestId("new-run-field-issueNumber");
  await expect(field).toBeVisible();
  await field.fill("7");
  await page.getByTestId("new-run-submit").click();

  // Navigate to the new run's detail page and watch it stream.
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/runs\/run-/);
  const runId = page.url().split("/").at(-1)!;
  await expect(page.getByTestId("run-meta")).toContainText("registry-test");
  await expect(page.getByTestId("run-meta")).toContainText("issueNumber=7");

  await expect(page.locator('[data-testid="step-row"][data-kind="agent"]').first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("run-meta")).toContainText(/finished/i, { timeout: 20_000 });

  const summary = (await (await page.request.get(`/api/runs/${runId}`)).json()) as {
    readonly workflowId: string;
    readonly status: string;
    readonly active: boolean;
  };
  expect(summary.workflowId).toBe("registry-test");
  expect(summary.active).toBe(false);
  expect(summary.status).toBe("RunFinished");
});

test("a schema the form cannot render falls back to raw JSON, with server errors inline", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("new-run-trigger").click();

  await page.getByTestId("new-run-workflow").selectOption("nested-input-test");
  const json = page.getByTestId("new-run-json");
  await expect(json).toBeVisible();

  await json.fill("{ not json");
  await page.getByTestId("new-run-submit").click();
  await expect(page.getByTestId("new-run-error")).toContainText("invalid JSON");

  await json.fill('{"spec": "nope"}');
  await page.getByTestId("new-run-submit").click();
  await expect(page.getByTestId("new-run-error")).toContainText("nested-input-test");
  await expect(page).not.toHaveURL(/\/runs\//);
});
