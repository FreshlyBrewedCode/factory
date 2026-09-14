import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * S4's transcript legs, matching the S3 precedent in `runs.e2e.ts`: a static
 * corpus-replay run whose expectations are derived from the same event log the
 * UI renders, and a live `createSlowFakeAdapter`/`live-workflow` run whose
 * transcript must fill in as the step streams. The static leg is also the
 * browser proof that `@tanstack/ai/client`'s `StreamProcessor` bundles and runs
 * in the SPA — finding 8 §6's biggest unverified risk.
 */

interface Frame {
  readonly seq: number;
  readonly payload: {
    readonly _tag: string;
    readonly stepId?: string;
    readonly name?: string;
    readonly prompt?: string;
    readonly chunkType?: string;
    readonly chunk?: { readonly [key: string]: unknown };
  };
}

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

function agentStep(
  events: ReadonlyArray<Frame>,
  name: string,
): { readonly stepId: string; readonly prompt: string } {
  const start = events.find(
    (frame) => frame.payload._tag === "AgentStepStarted" && frame.payload.name === name,
  );
  expect(start, `no AgentStepStarted named ${name}`).toBeDefined();
  return { stepId: start!.payload.stepId!, prompt: start!.payload.prompt! };
}

function chunksOf(events: ReadonlyArray<Frame>, stepId: string): ReadonlyArray<Frame> {
  return events.filter(
    (frame) => frame.payload._tag === "AgentChunk" && frame.payload.stepId === stepId,
  );
}

test("a step's transcript renders text, tool calls and reasoning from the event log", async ({
  page,
  request,
}) => {
  const events = await collectEvents(request, "run-static-corpus");

  const implement = agentStep(events, "implement");
  const implementChunks = chunksOf(events, implement.stepId);
  const toolName = implementChunks.find((frame) => frame.payload.chunkType === "TOOL_CALL_START")!
    .payload.chunk!.toolCallName as string;
  const textDeltas = implementChunks
    .filter((frame) => frame.payload.chunkType === "TEXT_MESSAGE_CONTENT")
    .map((frame) => frame.payload.chunk!.delta as string);
  // The first delta is the prompt echoed back; the last is the step's closing prose.
  const finalText = textDeltas.at(-1)!;
  expect(toolName).toBeTruthy();
  expect(finalText).not.toBe(implement.prompt);

  await page.goto("/runs/run-static-corpus");
  const implementRow = page
    .locator('[data-testid="step-row"][data-kind="agent"]')
    .filter({ hasText: "implement" })
    .first();
  await implementRow.click();

  await page.getByTestId("open-transcript").click();
  await expect(page.getByTestId("transcript")).toBeVisible();
  await expect(page.getByTestId("transcript-prompt")).toContainText(implement.prompt.slice(0, 48));
  // The echoed prompt is rendered once, as the header, not twice.
  await expect(page.getByTestId("transcript-prompt")).toContainText(implement.prompt.slice(0, 48));
  await expect(
    page.getByTestId("transcript-text").filter({ hasText: finalText.slice(0, 32) }),
  ).toHaveCount(1);
  // The tool call and its result share one disclosure, joined by toolCallId.
  await expect(
    page.getByTestId("transcript-tool").filter({ hasText: toolName }).first(),
  ).toBeVisible();

  // The back control restores the step detail.
  await page.getByTestId("transcript-back").click();
  await expect(page.getByTestId("transcript")).toHaveCount(0);
  await expect(page.getByTestId("step-detail")).toBeVisible();

  // The fix step folds reasoning into a disclosure.
  const fix = agentStep(events, "fix");
  const reasoning = chunksOf(events, fix.stepId).find(
    (frame) => frame.payload.chunkType === "REASONING_MESSAGE_CONTENT",
  )!.payload.chunk!.delta as string;
  const fixRow = page
    .locator('[data-testid="step-row"][data-kind="agent"]')
    .filter({ hasText: "fix" })
    .first();
  await fixRow.click();
  await page.getByTestId("open-transcript").click();
  await expect(
    page.getByTestId("transcript-reasoning").filter({ hasText: reasoning.slice(0, 48) }),
  ).toHaveCount(1);
});

test("a live step's transcript fills in as it streams and isolates per step", async ({
  page,
  request,
}) => {
  const workflowPath = fileURLToPath(new URL("../test/fixtures/live-workflow.ts", import.meta.url));
  const start = await request.post("/api/runs", {
    data: { workflowPath, input: {}, dir: "/tmp/factory-e2e-live-transcript" },
  });
  expect(start.status()).toBe(201);
  const { runId } = (await start.json()) as { readonly runId: string };

  await page.goto(`/runs/${runId}`);
  const agentRows = page.locator('[data-testid="step-row"][data-kind="agent"]');
  const firstRow = agentRows.first();
  await expect(firstRow).toHaveAttribute("data-status", "running", { timeout: 10_000 });
  await firstRow.click();
  await page.getByTestId("open-transcript").click();
  await expect(page.getByTestId("transcript")).toBeVisible();
  await expect(page.getByTestId("transcript-prompt")).toContainText("first step");

  // Opened before the text arrived: the transcript fills in under the reader.
  await expect(page.getByTestId("transcript-text")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("transcript-text")).toContainText("working");

  // Switching steps remounts the processor; the second step shows its own prompt.
  const secondRow = agentRows.nth(1);
  await expect(secondRow).toBeVisible({ timeout: 20_000 });
  await secondRow.click();
  await expect(page.getByTestId("transcript")).toHaveCount(0);
  await page.getByTestId("open-transcript").click();
  await expect(page.getByTestId("transcript-prompt")).toContainText("second step");
  await expect(page.getByTestId("transcript-prompt")).not.toContainText("first step");

  // Still watchable when the run lands terminal.
  await expect(page.getByTestId("run-meta")).toContainText(/finished/i, { timeout: 20_000 });
  await expect(page.getByTestId("transcript")).toBeVisible();
});
