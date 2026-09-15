import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { formatClock, formatDuration } from "../src/web/lib/format";

interface Frame {
  readonly seq: number;
  readonly ts: number;
  readonly payload: { readonly _tag: string; readonly [key: string]: unknown };
}

const KIND_OF_TAG: Readonly<Record<string, string>> = {
  AgentStepStarted: "agent",
  ExecStarted: "exec",
  WriteBackStarted: "writeback",
};

/** The SSE endpoint closes for a terminal run, so the full history reads as text. */
async function collectEvents(
  request: APIRequestContext,
  runId: string,
): Promise<ReadonlyArray<Frame>> {
  const res = await request.get(`/api/runs/${runId}/events`);
  expect(res.ok()).toBe(true);
  const text = await res.text();
  const frames: Array<Frame> = [];
  for (const raw of text.split("\n\n")) {
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    if (data !== undefined)
      frames.push(JSON.parse(data.slice("data:".length).trimStart()) as Frame);
  }
  return frames;
}

test("the runs list groups terminal runs newest-first with their derived status", async ({
  page,
}) => {
  await page.goto("/");

  const recent = page.getByTestId("runs-group-recent");
  await expect(recent).toBeVisible();
  // The list polls; wait for the first row so the order read below sees data.
  await expect(recent.locator('[data-testid^="run-row-"]').first()).toBeVisible();

  const rowIds = await recent
    .locator('[data-testid^="run-row-"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")));
  const seeded = rowIds.filter(
    (id) =>
      id === "run-row-run-static-corpus" ||
      id === "run-row-run-static-echo" ||
      id === "run-row-run-static-interrupted",
  );
  // Seeded order: corpus, then echo, then interrupted — so newest-first is reversed.
  expect(seeded).toEqual([
    "run-row-run-static-interrupted",
    "run-row-run-static-echo",
    "run-row-run-static-corpus",
  ]);

  await expect(page.getByTestId("run-row-run-static-corpus")).toHaveAttribute(
    "data-status",
    "finished",
  );
  await expect(page.getByTestId("run-row-run-static-echo")).toHaveAttribute(
    "data-status",
    "finished",
  );
  await expect(page.getByTestId("run-row-run-static-interrupted")).toHaveAttribute(
    "data-status",
    "interrupted",
  );
});

test("run detail meta matches the summary and the step list matches the event log", async ({
  page,
  request,
}) => {
  const summary = (await (await request.get("/api/runs/run-static-corpus")).json()) as {
    readonly runId: string;
    readonly workflowId: string;
    readonly dir: string;
    readonly startedAt: number;
    readonly status: string;
    readonly eventCount: number;
    readonly active: boolean;
  };
  const events = await collectEvents(request, summary.runId);
  const finished = events.find((frame) => frame.payload._tag === "RunFinished");
  const durationMs = finished?.payload["durationMs"] as number | undefined;

  await page.goto(`/runs/${summary.runId}`);

  const meta = page.getByTestId("run-meta");
  await expect(meta).toContainText(summary.runId);
  await expect(meta).toContainText(summary.workflowId);
  await expect(meta).toContainText(summary.dir);
  await expect(meta).toContainText(formatClock(summary.startedAt));
  await expect(meta).toContainText(formatDuration(durationMs));
  await expect(meta).toContainText("issueNumber=1");
  await expect(meta).toContainText("pr #1");
  await expect(meta.locator('[data-status="finished"]')).toHaveCount(1);

  // Count/kind/order of the rendered steps must match the events that produced
  // them: one row per AgentStepStarted/ExecStarted/WriteBackStarted, in seq order.
  const expectedKinds = events
    .map((frame) => KIND_OF_TAG[frame.payload._tag])
    .filter((kind): kind is string => kind !== undefined);
  const renderedKinds = await page
    .locator('[data-testid="step-row"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kind")));
  const stepKinds = renderedKinds.filter(
    (kind) => kind === "agent" || kind === "exec" || kind === "writeback",
  );
  expect(stepKinds).toEqual(expectedKinds);
  expect(expectedKinds).toContain("writeback");
  expect(expectedKinds.length).toBeGreaterThan(3);

  await page.getByRole("tab", { name: "events" }).click();
  await expect(page.getByTestId("event-row")).toHaveCount(summary.eventCount);
});

test("a started run reads as running with a ticking duration, then lands terminal", async ({
  page,
  request,
}) => {
  const workflowPath = fileURLToPath(new URL("../test/fixtures/live-workflow.ts", import.meta.url));
  const start = await request.post("/api/runs", {
    data: { workflowPath, input: {}, dir: "/tmp/factory-e2e-live" },
  });
  expect(start.status()).toBe(201);
  const { runId } = (await start.json()) as { readonly runId: string };

  await page.goto("/");
  const row = page.getByTestId(`run-row-${runId}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-status", "running");

  const duration = row.getByTestId("run-duration");
  const first = await duration.textContent();
  await expect.poll(() => duration.textContent(), { timeout: 5_000 }).not.toBe(first);

  // The detail appends steps from the live SSE tail: observe 1, then 2, then 3.
  await page.goto(`/runs/${runId}`);
  const agentRows = page.locator('[data-testid="step-row"][data-kind="agent"]');
  const observed: Array<number> = [];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const count = await agentRows.count();
    if (observed.at(-1) !== count) observed.push(count);
    if (count >= 3) break;
    await page.waitForTimeout(150);
  }
  expect(observed).toContain(1);
  expect(observed).toContain(2);
  expect(observed).toContain(3);

  await expect(page.getByTestId("run-meta")).toContainText(/finished/i, { timeout: 20_000 });
  await expect(
    page.locator('[data-testid="step-row"][data-kind="agent"][data-status="completed"]'),
  ).toHaveCount(3);

  const after = (await (await request.get(`/api/runs/${runId}`)).json()) as {
    readonly active: boolean;
    readonly status: string;
  };
  expect(after.active).toBe(false);
  expect(after.status).toBe("RunFinished");
});
