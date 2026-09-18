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

describe("startRun workspace kind (issue #13)", () => {
  test("ctx.writeBack on a scratch workspace fails naming the kind, recorded like any other failure", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("scratch-wb", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        return await ctx.writeBack({
          branch: "scratch/nothing",
          commitMessage: "x",
          prTitle: "x",
          prBody: "x",
        });
      },
    });

    const handle = startRun(workflow, {
      runId: "run-scratch-wb",
      dir: "/tmp/nothing",
      input: {},
      adapter: createSlowFakeAdapter([]),
      workspaceKind: "scratch",
      repo: { slug: "owner/repo", baseBranch: "main" },
      onEvent: (event) => events.push(event),
    });

    const outcome = await handle.result;
    expect(outcome.outcome).toBe("failed");

    const finished = events.find((e) => e.payload._tag === "WriteBackFinished");
    expect(finished?.payload).toMatchObject({ outcome: "failed" });
    expect(
      finished?.payload._tag === "WriteBackFinished" && finished.payload.error?.includes("scratch"),
    ).toBe(true);
    // No git ran to reach the failure: no Exec events at all.
    expect(events.some((e) => e.payload._tag === "ExecStarted")).toBe(false);
  });

  test("ctx.writeBack still behaves as before on a clone workspace", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("clone-wb", {
      input: Schema.Struct({}),
      run: async (ctx) =>
        await ctx.writeBack({
          branch: "clone/nothing",
          commitMessage: "x",
          prTitle: "x",
          prBody: "x",
        }),
    });

    const handle = startRun(workflow, {
      runId: "run-clone-wb",
      dir: "/tmp/nothing",
      input: {},
      adapter: createSlowFakeAdapter([]),
      repo: { slug: "owner/repo", baseBranch: "main" },
      onEvent: (event) => events.push(event),
    });

    await handle.result;
    // Not the workspace-kind guard: write-back proceeds to git and fails there.
    expect(
      events.some(
        (e) =>
          e.payload._tag === "WriteBackFinished" && (e.payload.error ?? "").includes("scratch"),
      ),
    ).toBe(false);
  });

  test("RunStarted records the workspace kind, defaulting to clone", async () => {
    const workflow = defineWorkflow("kind-echo", {
      input: Schema.Struct({}),
      run: async () => ({}),
    });

    const scratchEvents: Array<RunEvent> = [];
    await startRun(workflow, {
      runId: "run-kind-scratch",
      dir: "/tmp/s",
      input: {},
      adapter: createSlowFakeAdapter([]),
      workspaceKind: "scratch",
      onEvent: (event) => scratchEvents.push(event),
    }).result;
    const cloneEvents: Array<RunEvent> = [];
    await startRun(workflow, {
      runId: "run-kind-clone",
      dir: "/tmp/c",
      input: {},
      adapter: createSlowFakeAdapter([]),
      onEvent: (event) => cloneEvents.push(event),
    }).result;

    expect(
      scratchEvents[0]?.payload._tag === "RunStarted" && scratchEvents[0].payload.workspaceKind,
    ).toBe("scratch");
    expect(
      cloneEvents[0]?.payload._tag === "RunStarted" && cloneEvents[0].payload.workspaceKind,
    ).toBe("clone");
  });
});

describe("startRun schedule trigger (issue #16)", () => {
  test("RunStarted records the starting schedule when started by one", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("scheduled-echo", {
      input: Schema.Struct({ issueNumber: Schema.Number }),
      run: async (ctx) => {
        const result = await ctx.agent("step", "irrelevant, replay ignores it");
        return { finalText: result.finalText };
      },
    });
    const handle = startRun(workflow, {
      runId: "run-by-schedule",
      dir: "/tmp",
      input: { issueNumber: 7 },
      adapter: createSlowFakeAdapter(SLOW_CHUNKS, 5),
      scheduleId: "nightly",
      onEvent: (event) => events.push(event),
    });
    await handle.result;
    const started = events.find((e) => e.payload._tag === "RunStarted");
    expect(started?.payload).toMatchObject({ scheduleId: "nightly" });
  });

  test("a run started without a schedule records none", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("unscheduled-echo", {
      input: Schema.Struct({}),
      run: async () => ({}),
    });
    const handle = startRun(workflow, {
      runId: "run-manual",
      dir: "/tmp",
      input: {},
      adapter: createSlowFakeAdapter([]),
      onEvent: (event) => events.push(event),
    });
    await handle.result;
    const started = events.find((e) => e.payload._tag === "RunStarted");
    expect(started?.payload._tag === "RunStarted" && "scheduleId" in started.payload).toBe(false);
  });
});

describe("startRun model precedence (issue #16)", () => {
  test("an agent-level override from the schedule wins over the workflow default, and a per-call option over it", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("model-precedence", {
      input: Schema.Struct({}),
      agent: { model: "workflow-default" },
      run: async (ctx) => {
        await ctx.agent("scheduled-step", "irrelevant, replay ignores it");
        await ctx.agent("explicit-step", "irrelevant, replay ignores it", {
          model: "per-call-explicit",
        });
        return {};
      },
    });
    const handle = startRun(workflow, {
      runId: "run-models",
      dir: "/tmp",
      input: {},
      adapter: createSlowFakeAdapter(SLOW_CHUNKS, 5),
      agentOverrides: { model: "schedule-override" },
      onEvent: (event) => events.push(event),
    });
    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");

    const models = events
      .filter((e) => e.payload._tag === "AgentStepStarted")
      .map((e) => (e.payload._tag === "AgentStepStarted" ? e.payload.model : undefined));
    // run request > schedule > workflow > config default
    expect(models).toEqual(["schedule-override", "per-call-explicit"]);
  });

  test("without a schedule override, the workflow default applies as before", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("model-precedence-fallback", {
      input: Schema.Struct({}),
      agent: { model: "workflow-default" },
      run: async (ctx) => {
        await ctx.agent("step", "irrelevant, replay ignores it");
        return {};
      },
    });
    const handle = startRun(workflow, {
      runId: "run-models-fallback",
      dir: "/tmp",
      input: {},
      adapter: createSlowFakeAdapter(SLOW_CHUNKS, 5),
      onEvent: (event) => events.push(event),
    });
    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");
    const started = events.find((e) => e.payload._tag === "AgentStepStarted");
    expect(started?.payload._tag === "AgentStepStarted" && started.payload.model).toBe(
      "workflow-default",
    );
  });
});
