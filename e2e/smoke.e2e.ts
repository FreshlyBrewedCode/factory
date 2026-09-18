import { expect, test } from "@playwright/test";

/**
 * S2's smoke test: the SPA is on screen at `/`, React actually mounted, and
 * the API answers from the same origin the page was served from. S3's backend
 * seeds real runs into the temp db, so the smoke assertions no longer expect an
 * empty list — just that the shell and the API are live.
 */
test("the SPA shell renders and the same-origin API answers", async ({ page, request }) => {
  const api = await request.get("/api/runs");
  expect(api.ok()).toBe(true);
  expect(api.headers()["content-type"]).toContain("application/json");
  expect(Array.isArray(await api.json())).toBe(true);

  await page.goto("/");

  await expect(page).toHaveTitle("factory");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByTestId("runs-group-recent")).toBeVisible();
});

test("client-side nav reaches the other category pages through the router", async ({ page }) => {
  await page.goto("/");
  // The Dispatch page came out with the legacy dispatcher (issue #18): the nav
  // now reaches Schedules, which reads the running config.
  await page.getByRole("link", { name: "Schedules" }).click();
  await expect(page).toHaveURL(/\/schedules$/);
  await expect(page.getByTestId("schedules-page")).toBeVisible();
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("runs-group-recent")).toBeVisible();
});
