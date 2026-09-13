/**
 * Cancellation regression test (STATUS.md phase 1 exit criterion). Pins
 * Factory's own `RunOutcome`/`RunEvent` contract — a `cancelled` outcome and
 * an `AgentStepFinished{outcome:"cancelled"}` event — independent of
 * `Fiber`/`Exit` internals, which `run.ts` already had to work around once
 * (see its `Exit.isFailure`/`Exit.hasInterrupts` narrowing note).
 */

import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../events";
import { defineWorkflow, Schema } from "../workflow";
import { createSlowFakeAdapter } from "../replay/adapter";
import { startRun } from "./run";

const SLOW_CHUNKS = [
  { type: "TEXT_MESSAGE_START" },
  { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
  { type: "TEXT_MESSAGE_CONTENT", delta: " there" },
  { type: "TEXT_MESSAGE_END" },
];

describe("startRun cancellation", () => {
  test("cancel() mid agent-step resolves the run as cancelled, not failed", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("cancel-test", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        await ctx.agent("slow-step", "irrelevant, replay ignores it");
        return {};
      },
    });

    const handle = startRun(workflow, {
      runId: "run-cancel-test",
      dir: "/tmp",
      input: {},
      adapter: createSlowFakeAdapter(SLOW_CHUNKS, 20),
      onEvent: (event) => events.push(event),
    });

    // Let the first chunk or two land, then cancel while the step is still streaming.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await handle.cancel();

    const outcome = await handle.result;
    expect(outcome.outcome).toBe("cancelled");

    const stepFinished = events.find((e) => e.payload._tag === "AgentStepFinished");
    expect(stepFinished).toBeDefined();
    expect(stepFinished?.payload).toMatchObject({ outcome: "cancelled" });

    const runCancelled = events.find((e) => e.payload._tag === "RunCancelled");
    expect(runCancelled).toBeDefined();

    const runFailed = events.find((e) => e.payload._tag === "RunFailed");
    expect(runFailed).toBeUndefined();
  });

  test("an uninterrupted run completes normally through the same adapter", async () => {
    const workflow = defineWorkflow("no-cancel-test", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        const result = await ctx.agent("fast-step", "irrelevant, replay ignores it");
        return { finalText: result.finalText };
      },
    });

    const handle = startRun(workflow, {
      runId: "run-no-cancel-test",
      dir: "/tmp",
      input: {},
      adapter: createSlowFakeAdapter(SLOW_CHUNKS, 1),
      onEvent: () => {},
    });

    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome === "completed") {
      expect(outcome.output).toEqual({ finalText: "hi there" });
    }
  });
});
