import { expect, test } from "@playwright/test";

/**
 * S2's smoke test: the SPA is on screen at `/`, React actually mounted, and
 * the API answers from the same origin the page was served from. Wired while
 * there is nothing to break, so later steps inherit a working harness rather
 * than debugging playwright and the UI at once.
 */
test("the SPA shell renders and the same-origin API answers", async ({ page, request }) => {
  const api = await request.get("/api/runs");
  expect(api.ok()).toBe(true);
  expect(api.headers()["content-type"]).toContain("application/json");
  expect(await api.json()).toEqual([]);

  await page.goto("/");

  await expect(page).toHaveTitle("factory");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByText("0 recorded")).toBeVisible();
});

test("client-side nav reaches the other category pages through the router", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Dispatch" }).click();
  await expect(page).toHaveURL(/\/dispatch$/);
  await expect(page.getByRole("heading", { name: "Dispatch" })).toBeVisible();

  await page.getByRole("link", { name: "Workflows" }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
});
