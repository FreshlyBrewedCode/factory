/**
 * Issue #14: run detail navigates parent → child and child → parent, both
 * from the event links alone (RunDispatched on the parent's log,
 * RunStarted.parentId on the child's). The parent/child pair is seeded by
 * hand in `server.ts`; the browser only proves the UI wiring.
 */

import { expect, test } from "@playwright/test";

test("run detail navigates parent → child and child → parent", async ({ page }) => {
  await page.goto("/runs/run-static-tree");

  const meta = page.getByTestId("run-meta");
  await expect(meta).toBeVisible();

  // Parent → child: the "children" row links directly to run detail.
  const childLink = page.getByRole("link", { name: "run-static-tree-child" });
  await expect(childLink).toBeVisible();
  await childLink.click();
  await expect(page.getByTestId("run-detail")).toBeVisible();
  await expect(page.getByTestId("run-detail")).toContainText("run-static-tree-child");

  // Child → parent: the "origin" row links back.
  const originLink = page.getByRole("link", { name: "run-static-tree" }).first();
  await expect(originLink).toBeVisible();
  await originLink.click();
  await expect(page.getByTestId("run-detail")).toBeVisible();
  await expect(page.getByTestId("run-detail")).toContainText("run-static-tree");
});
