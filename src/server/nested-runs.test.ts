/**
 * Issue #14, server side: the wiring that turns an injected `dispatch`
 * service into real child runs.
 *
 * `dispatchChildRun` validates before it starts anything, so `ctx.dispatch`
 * can *reject* rather than silently drop — concurrency admission, dispatch
 * depth and the per-run child cap all throw into the parent (its `RunFailed`
 * carries the message). A validated child is then started fire-and-forget
 * with the parent's run id recorded on its `RunStarted.parentId`, and the
 * parent never exposes an awaitable child (D-epic 19).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { getRunEvents, listRuns, openStore } from "../persistence/store";
import { createSlowFakeAdapter } from "../replay/adapter";
import { activeRunIds, isActive, startTrackedRun } from "./runs";
import { defineWorkflow } from "../workflow";
import { makeAgentRuntime } from "../runtime/agent-runtime";

const SLOW_ADAPTER = createSlowFakeAdapter(
  [
    { type: "TEXT_MESSAGE_START" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
    { type: "TEXT_MESSAGE_END" },
  ],
  25,
);

const runtime = makeAgentRuntime(SLOW_ADAPTER);

// The child does a real ctx.exec so its outcome is observable in its log.
// Scratch (issue #13): no mirror refresh, so no git fixture is needed.
const numberedChild = defineWorkflow("child-wf", {
  input: Schema.Struct({ n: Schema.Finite }),
  workspace: { kind: "scratch" },
  run: async (ctx) => {
    await ctx.exec(["sh", "-c", "true"]);
    return { n: 1 };
  },
});

const selfDispatching = defineWorkflow("self-dispatch-wf", {
  input: Schema.Struct({}),
  workspace: { kind: "scratch" },
  run: async (ctx) => {
    await ctx.dispatch(selfDispatching, {});
    return {};
  },
});

const manyChildren = defineWorkflow("many-children-wf", {
  input: Schema.Struct({}),
  workspace: { kind: "scratch" },
  run: async (ctx) => {
    for (let i = 0; i < 25; i++) {
      await ctx.dispatch(numberedChild, { n: i });
    }
    return { ran: "all" };
  },
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met within timeout");
}

function tagsOf(db: Database, runId: string): ReadonlyArray<string> {
  return getRunEvents(db, runId).map((event) => event.payload._tag);
}

describe("nested runs through the daemon (issue #14)", () => {
  test("parent dispatches a real child: RunDispatched on the parent, parentId on the child, both reach terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-nested-happy-"));
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "workspaces"), { recursive: true });

    const parent = defineWorkflow("parent-wf", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        const childRunId = await ctx.dispatch(numberedChild, { n: 7 });
        return { childRunId };
      },
    });

    const parentRunId = await startTrackedRun(runtime, db, parent, {
      workspace: {
        workspaceRoot: join(root, "workspaces"),
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Test Bot", email: "test@factory.local" },
        retainedWorkspaces: 10,
      },
      input: {},
      dispatchEnv: {
        workspace: {
          workspaceRoot: join(root, "workspaces"),
          sshUrl: join(root, "seed-not-used"),
          identity: { name: "Test Bot", email: "test@factory.local" },
          retainedWorkspaces: 10,
        },
      },
    });

    await waitFor(() => !isActive(parentRunId) && activeRunIds().length === 0);

    const parentEvents = getRunEvents(db, parentRunId);
    const dispatched = parentEvents.find((e) => e.payload._tag === "RunDispatched");
    expect(dispatched).toBeDefined();
    const childRunId =
      dispatched?.payload._tag === "RunDispatched" ? dispatched.payload.childRunId : undefined;
    expect(childRunId).toBeDefined();

    const childStarted = (childRunId ? getRunEvents(db, childRunId) : []).find(
      (e) => e.payload._tag === "RunStarted",
    );
    expect(
      childStarted !== undefined && childStarted.payload._tag === "RunStarted"
        ? childStarted.payload.parentId
        : "missing",
    ).toBe(parentRunId);
    expect(
      childStarted !== undefined && childStarted.payload._tag === "RunStarted"
        ? childStarted.payload.workflowId
        : "missing",
    ).toBe("child-wf");

    // The child actually ran to completion under the daemon.
    const childSummary = listRuns(db).find((run) => run.runId === childRunId);
    expect(childSummary?.status).toBe("RunFinished");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("self-dispatch is capped at maxDispatchDepth; the rejected run fails visibly", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-nested-depth-"));
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "workspaces"), { recursive: true });

    await startTrackedRun(runtime, db, selfDispatching, {
      input: {},
      workspace: {
        workspaceRoot: join(root, "workspaces"),
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Test Bot", email: "test@factory.local" },
        retainedWorkspaces: 20,
      },
      maxConcurrentRuns: 20,
      dispatchEnv: {
        workspace: {
          workspaceRoot: join(root, "workspaces"),
          sshUrl: join(root, "seed-not-used"),
          identity: { name: "Test Bot", email: "test@factory.local" },
          retainedWorkspaces: 20,
        },
        maxConcurrentRuns: 20,
      },
    });

    await waitFor(() => activeRunIds().length === 0);

    // The chain built to the cap, no farther: root + 5 children max.
    const selfRuns = listRuns(db).filter((run) => run.workflowId === "self-dispatch-wf");
    const failedStates = new Set(["RunFailed", "RunCancelled", "interrupted"]);
    const completed = selfRuns.filter(
      (run) => !failedStates.has(run.status) && run.status !== "RunFinished",
    );
    expect(completed.length).toBe(0);

    const deepestFailed = selfRuns.find((run) => run.status === "RunFailed");
    expect(deepestFailed).toBeDefined();
    const failedEvents = deepestFailed !== undefined ? getRunEvents(db, deepestFailed.runId) : [];
    const runFailed = failedEvents.find((event) => event.payload._tag === "RunFailed");
    expect(
      runFailed !== undefined && runFailed.payload._tag === "RunFailed"
        ? runFailed.payload.message
        : "missing",
    ).toMatch(/dispatch depth/);

    expect(selfRuns.length).toBeLessThanOrEqual(7);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("per-run child count is capped at maxChildrenPerRun", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-nested-count-"));
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "workspaces"), { recursive: true });

    const parentRunId = await startTrackedRun(runtime, db, manyChildren, {
      input: {},
      workspace: {
        workspaceRoot: join(root, "workspaces"),
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Test Bot", email: "test@factory.local" },
        retainedWorkspaces: 30,
      },
      maxConcurrentRuns: 40,
      dispatchEnv: {
        workspace: {
          workspaceRoot: join(root, "workspaces"),
          sshUrl: join(root, "seed-not-used"),
          identity: { name: "Test Bot", email: "test@factory.local" },
          retainedWorkspaces: 30,
        },
        maxConcurrentRuns: 40,
        maxChildrenPerRun: 5,
      },
    });

    await waitFor(() => activeRunIds().length === 0);

    expect(tagsOf(db, parentRunId).filter((tag) => tag === "RunDispatched").length).toBe(5);
    const parentEvents = getRunEvents(db, parentRunId);
    const failed = parentEvents.find((event) => event.payload._tag === "RunFailed");
    expect(
      failed !== undefined && failed.payload._tag === "RunFailed"
        ? failed.payload.message
        : "missing",
    ).toMatch(/child cap/);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a child over the concurrency limit is rejected by ctx.dispatch, failing the parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-nested-wip-"));
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "workspaces"), { recursive: true });

    const parent = defineWorkflow("parent-wip-wf", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        await ctx.dispatch(numberedChild, { n: 1 });
        return {};
      },
    });

    const parentRunId = await startTrackedRun(runtime, db, parent, {
      input: {},
      workspace: {
        workspaceRoot: join(root, "workspaces"),
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Test Bot", email: "test@factory.local" },
        retainedWorkspaces: 5,
      },
      maxConcurrentRuns: 1,
      dispatchEnv: {
        workspace: {
          workspaceRoot: join(root, "workspaces"),
          sshUrl: join(root, "seed-not-used"),
          identity: { name: "Test Bot", email: "test@factory.local" },
          retainedWorkspaces: 5,
        },
        maxConcurrentRuns: 1,
      },
    });

    await waitFor(() => !isActive(parentRunId));

    const events = getRunEvents(db, parentRunId);
    expect(events.map((event) => event.payload._tag)).not.toContain("RunDispatched");
    const failed = events.find((event) => event.payload._tag === "RunFailed");
    expect(
      failed !== undefined && failed.payload._tag === "RunFailed" ? failed.payload.message : "",
    ).toMatch(/concurrency limit/);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
