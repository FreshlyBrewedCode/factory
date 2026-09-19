/**
 * Issue #14: `ctx.dispatch` — fire-and-forget nested runs.
 *
 * The runtime's job here is narrow: it surfaces `ctx.dispatch` on the
 * `ctx`, passes the child workflow and input to an injected dispatch
 * service, and emits `RunDispatched` on the parent's own log with its
 * runtime-assigned seq. Flow control (concurrency, dispatch caps) is the
 * server's job — `src/server/runs.ts` is the only wiring that passes the
 * service in, so a run executing in-process (no daemon) throws.
 *
 * Child input is decoded at run start by `startRun`, exactly like any other
 * run's input — covered by the runtime suite — so it is not re-decoded here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { RunEvent } from "./events";
import { createSlowFakeAdapter } from "./replay/adapter";
import { makeAgentRuntime } from "./runtime/agent-runtime";
import { startRun } from "./runtime/run";
import { defineWorkflow } from "./workflow";

const SLOW_ADAPTER = createSlowFakeAdapter(
  [
    { type: "TEXT_MESSAGE_START" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
    { type: "TEXT_MESSAGE_END" },
  ],
  50,
);

const numberedChild = defineWorkflow("child-wf", {
  input: Schema.Struct({ n: Schema.Finite }),
  run: async (ctx) => {
    await ctx.exec(["sh", "-c", "true"]);
    return { n: 1 };
  },
});

describe("ctx.dispatch (issue #14)", () => {
  test("starts the child, resolves to its run id, and never waits for it", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dispatch-no-wait-"));

    let childStarted = false;
    let childResolved = false;

    const parent = defineWorkflow("parent-wf", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        const childRunId = await ctx.dispatch(numberedChild, { n: 1 });
        expect(typeof childRunId).toBe("string");
        childResolved = true;
        return { childRunId };
      },
    });

    const runtime = makeAgentRuntime(SLOW_ADAPTER);
    const handle = await startRun(parent, runtime, {
      runId: "run-parent-1",
      dir: root,
      input: {},
      dispatch: (_child, _input): Promise<string> => {
        void _child;
        void _input;
        childStarted = true;
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve("run-child-1"), 50);
        });
      },
      onEvent: () => undefined,
    });

    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");
    expect((outcome as { output: Record<string, unknown> }).output.childRunId).toBe("run-child-1");
    expect(childStarted).toBe(true);
    expect(childResolved).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  test("the parent's log records RunDispatched; the child's log carries RunStarted.parentId", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dispatch-tree-"));
    const parentEvents: Array<RunEvent> = [];
    let childEvents: Array<RunEvent> = [];

    const parent = defineWorkflow("parent-wf", {
      input: Schema.Struct({}),
      run: async (ctx) => ctx.dispatch(numberedChild, { n: 1 }),
    });

    let childResult: Promise<{ outcome: string }> | undefined;
    const runtime = makeAgentRuntime(SLOW_ADAPTER);

    const handle = await startRun(parent, runtime, {
      runId: "run-parent-x",
      dir: root,
      input: {},
      dispatch: async (childWorkflow, input) => {
        void childWorkflow.id;
        childEvents = [];
        const childRun = await startRun(childWorkflow as never, runtime, {
          runId: "run-child-x",
          dir: root,
          input,
          parentRunId: "run-parent-x",
          onEvent: (event) => {
            childEvents.push(event);
          },
        });
        childResult = childRun.result;
        return "run-child-x";
      },
      onEvent: (event) => {
        parentEvents.push(event);
      },
    });

    await handle.result;
    expect(childResult !== undefined ? (await childResult).outcome : "corrupt").toBe("completed");
    const dispatchTag = parentEvents.find((event) => event.payload._tag === "RunDispatched");
    expect(dispatchTag === undefined ? "missing" : dispatchTag.payload._tag).toBe("RunDispatched");
    if (dispatchTag !== undefined && dispatchTag.payload._tag === "RunDispatched") {
      expect(dispatchTag.payload.childRunId).toBe("run-child-x");
      expect(dispatchTag.payload.childWorkflowId).toBe("child-wf");
      expect(dispatchTag.payload.input).toEqual({ n: 1 });
      expect(dispatchTag.seq).toBe(1);
    }

    const childStarted = childEvents.find((event) => event.payload._tag === "RunStarted");
    expect(childStarted === undefined ? "missing" : childStarted.payload._tag).toBe("RunStarted");
    if (childStarted !== undefined && childStarted.payload._tag === "RunStarted") {
      expect(childStarted.payload.parentId).toBe("run-parent-x");
    }

    rmSync(root, { recursive: true, force: true });
  });

  test("throws when the run has no dispatch service (in-process execution)", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dispatch-nondaemon-"));

    const parent = defineWorkflow("parent-wf", {
      input: Schema.Struct({}),
      run: async (ctx) => ctx.dispatch(numberedChild, { n: 1 }),
    });

    const runtime = makeAgentRuntime(SLOW_ADAPTER);
    const handle = await startRun(parent, runtime, {
      runId: "run-no-daemon",
      dir: root,
      input: {},
      onEvent: () => undefined,
    });

    const outcome = await handle.result;
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome !== "failed") return;
    expect(outcome.error).toContain("ctx.dispatch");
    expect(outcome.error).toContain("daemon");

    rmSync(root, { recursive: true, force: true });
  });
});

// The call-site type contract, compiled right next to the real dispatch
// calls: `numberedChild`'s input is `{ n: number }`, so `ctx.dispatch` with
// a wrong-typed input must be a type error. The correctly-typed call already
// compiles — the tests above exercise it.
import type { WorkflowCtx } from "./workflow";
const wronglyTypedInput: { n: string } = { n: "wrong" };

// Not invoked — the marked compile error is the assertion.
export async function typeCheckOnly(ctx: WorkflowCtx): Promise<void> {
  // @ts-expect-error ctx.dispatch type-checks the input against the child's schema
  await ctx.dispatch(numberedChild, wronglyTypedInput);
  await ctx.dispatch(numberedChild, { n: 1 });
}
