/**
 * M1/L1 review fixes, against the registry the server actually uses:
 *
 * - an admitted run reserves its registry slot *before* any await (M1) —
 *   check-then-set with no await gap, so a concurrent start cannot lose the
 *   race; the slot is released when allocation/startup throws.
 * - a `cancel` arriving while a run is only a reserved slot is deferred into
 *   run start (L1): the run starts, is cancelled immediately, and ends as a
 *   clean RunCancelled with no orphaned slot.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../events";
import echoWorkflow from "../../test/fixtures/echo-workflow";
import { appendEvent, openStore, getRunEvents } from "../persistence/store";
import { createSlowFakeAdapter } from "../replay/adapter";
import { makeAgentRuntime } from "../runtime/agent-runtime";
import { defineWorkflow, Schema } from "../workflow";
import {
  ConcurrencyLimitError,
  DispatchCapError,
  activeRunIds,
  cancelRegisteredRun,
  getActiveHandle,
  isActive,
  startTrackedRun,
} from "./runs";

const SLOW_ADAPTER = createSlowFakeAdapter(
  [
    { type: "TEXT_MESSAGE_START" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
    { type: "TEXT_MESSAGE_END" },
  ],
  25,
);

const runtime = makeAgentRuntime(SLOW_ADAPTER);

const sleepWorkflow = defineWorkflow("sleep-test", {
  input: Schema.Struct({}),
  run: async (ctx) => {
    await ctx.exec(["sleep", "30"]);
    return {};
  },
});

function tmpRoot(): { root: string; finish: () => void } {
  const root = mkdtempSync(join(tmpdir(), "factory-runs-test-"));
  return { root, finish: () => rmSync(root, { recursive: true, force: true }) };
}

interface Gate {
  readonly wait: () => Promise<void>;
  readonly release: () => void;
}

function makeGate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => promise, release };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met within timeout");
}

describe("domain errors as TaggedError (#34)", () => {
  test("ConcurrencyLimitError carries _tag and maxConcurrentRuns", () => {
    const err = new ConcurrencyLimitError({ maxConcurrentRuns: 5 });
    expect(err._tag).toBe("ConcurrencyLimitError");
    expect(err.maxConcurrentRuns).toBe(5);
    expect(err instanceof Error).toBe(true);
  });

  test("DispatchCapError carries _tag and message", () => {
    const err = new DispatchCapError({ message: "depth exceeded" });
    expect(err._tag).toBe("DispatchCapError");
    expect(err.message).toContain("depth exceeded");
    expect(err instanceof Error).toBe(true);
  });

  test("domain errors are matchable by _tag from an unknown catch", () => {
    const errors = [
      new ConcurrencyLimitError({ maxConcurrentRuns: 1 }),
      new DispatchCapError({ message: "cap" }),
    ];
    for (const err of errors) {
      try {
        throw err;
      } catch (caught: unknown) {
        const e = caught as { _tag?: string };
        expect(typeof e._tag).toBe("string");
      }
    }
  });
});

describe("startTrackedRun admission (M1: the slot is reserved before any await)", () => {
  test("a second start while the first is still reserving is refused atomically, and the slot frees after", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const gate = makeGate();

    const first = startTrackedRun(runtime, db, echoWorkflow, {
      runId: "run-first",
      dir: join(root, "first-dir"),
      input: {},
      maxConcurrentRuns: 1,
      beforeStart: gate.wait,
    });

    await waitFor(() => activeRunIds().length === 1);
    expect(activeRunIds()).toEqual(["run-first"]);
    expect(getActiveHandle("run-first")).toBeUndefined();

    const second = startTrackedRun(runtime, db, echoWorkflow, {
      runId: "run-second",
      dir: join(root, "second-dir"),
      input: {},
      maxConcurrentRuns: 1,
    });

    expect(
      second.then(
        () => "resolved",
        (err: unknown) => err,
      ),
    ).resolves.toBeInstanceOf(ConcurrencyLimitError);

    gate.release();
    const firstRunId = await first;
    expect(firstRunId).toBe("run-first");
    await waitFor(() => !isActive(firstRunId));
    expect(activeRunIds()).toEqual([]);

    db.close();
    finish();
  });

  test("a failed allocation releases the reserved slot", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));

    await expect(
      startTrackedRun(runtime, db, echoWorkflow, {
        runId: "run-doomed",
        input: {},
        maxConcurrentRuns: 1,
        workspace: {
          workspaceRoot: join(root, "workspaces"),
          sshUrl: join(root, "does-not-exist"),
          identity: { name: "T", email: "t@t.test" },
          retainedWorkspaces: 10,
        },
      }),
    ).rejects.toThrow(/workspace/);

    expect(activeRunIds()).toEqual([]);

    const runId = await startTrackedRun(runtime, db, echoWorkflow, {
      dir: join(root, "dir"),
      input: {},
      maxConcurrentRuns: 1,
    });
    expect(activeRunIds()).toEqual([runId]);
    await waitFor(() => !isActive(runId));

    db.close();
    finish();
  });
});

describe("cancel of a reserved-but-not-started run (L1)", () => {
  test("cancelling during the allocation window defers into run start; the run ends cancelled with no leak", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "dir"), { recursive: true });
    const gate = makeGate();

    const starting = startTrackedRun(runtime, db, sleepWorkflow, {
      runId: "run-gated",
      dir: join(root, "dir"),
      input: {},
      maxConcurrentRuns: 1,
      beforeStart: gate.wait,
    });

    await waitFor(() => activeRunIds().length === 1);
    expect(getActiveHandle("run-gated")).toBeUndefined();

    const cancelled = cancelRegisteredRun("run-gated");
    expect(cancelled).toEqual({ kind: "reserved" });

    gate.release();
    const runId = await starting;
    expect(runId).toBe("run-gated");

    await waitFor(() => activeRunIds().length === 0);
    const events = getRunEvents(db, runId).map((e) => e.payload._tag);
    expect(events).toContain("RunStarted");
    expect(events).toContain("RunCancelled");
    expect(cancelRegisteredRun(runId)).toBeUndefined();

    await Bun.sleep(50);
    expect(activeRunIds()).toEqual([]);

    db.close();
    finish();
  }, 10_000);
});

describe("scratch workspaces through startTrackedRun (issue #13)", () => {
  const scratchWorkflow = defineWorkflow("scratch-test", {
    input: Schema.Struct({}),
    workspace: { kind: "scratch" },
    run: async (ctx) => {
      const result = await ctx.agent("step", "irrelevant, replay ignores it");
      return { finalText: result.finalText };
    },
  });
  const failingScratchWorkflow = defineWorkflow("scratch-fail-test", {
    input: Schema.Struct({}),
    workspace: { kind: "scratch" },
    run: async () => {
      throw new Error("precondition check failed");
    },
  });

  function workspaceSpec() {
    return {
      workspaceRoot: join(tmpRootDir(), "workspaces"),
      sshUrl: join(tmpRootDir(), "seed"),
      identity: { name: "Test Bot", email: "test@factory.local" },
      retainedWorkspaces: 10,
    };
  }

  let _tmp = "";
  function tmpRootDir() {
    return _tmp;
  }

  test("a scratch run gets an empty directory with no mirror and no clone", async () => {
    const { root, finish } = tmpRoot();
    _tmp = root;
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "seed"), { recursive: true });

    const runId = await startTrackedRun(runtime, db, failingScratchWorkflow, {
      runId: "run-scratch-empty",
      workspace: { ...workspaceSpec(), sshUrl: join(root, "no-such-remote") },
      input: {},
    });
    await waitFor(() => !isActive(runId));

    const dir = join(root, "workspaces", "run-scratch-empty");
    expect(existsSync(dir)).toBe(true);
    // failing, so the dir survives for inspection (a completed scratch dir is reaped).
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(root, "workspaces", ".mirror.git"))).toBe(false);
    finish();
  });

  test("a completed scratch run is reaped; a failed one is kept for inspection", async () => {
    const { root, finish } = tmpRoot();
    _tmp = root;
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "seed"), { recursive: true });

    const okId = await startTrackedRun(runtime, db, scratchWorkflow, {
      runId: "run-scratch-ok",
      workspace: workspaceSpec(),
      input: {},
    });
    await waitFor(() => !isActive(okId));
    await new Promise((resolve) => setTimeout(resolve, 50)); // reap lands async
    expect(existsSync(join(root, "workspaces", "run-scratch-ok"))).toBe(false);

    const badId = await startTrackedRun(runtime, db, failingScratchWorkflow, {
      runId: "run-scratch-bad",
      workspace: workspaceSpec(),
      input: {},
    });
    await waitFor(() => !isActive(badId));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(root, "workspaces", "run-scratch-bad"))).toBe(true);
    finish();
  });

  test("a scratch leftover does not evict clone workspaces from retention", async () => {
    const { root, finish } = tmpRoot();
    _tmp = root;
    const db = openStore(join(root, "factory.db"));
    const seed = join(root, "seed");
    await Bun.$`git init -b main -q ${seed}`.quiet();

    // A kept (failed) scratch dir, already recorded in the log.
    appendEvent(db, {
      runId: "run-scratch-kept",
      seq: 0,
      ts: Date.now(),
      payload: {
        _tag: "RunStarted",
        workflowId: "scratch-test",
        dir: join(root, "workspaces", "run-scratch-kept"),
        input: {},
        workspaceKind: "scratch",
      },
    } satisfies RunEvent);
    mkdirSync(join(root, "workspaces", "run-scratch-kept"), { recursive: true });

    // retention = 1: with the scratch dir correctly excluded, the only clone
    // survives: the leftover must not count toward retention.
    await startTrackedRun(runtime, db, echoWorkflow, {
      runId: "run-clone",
      workspace: { ...workspaceSpec(), sshUrl: seed, retainedWorkspaces: 1 },
      input: {},
    });
    await waitFor(() => !isActive("run-clone"));

    expect(existsSync(join(root, "workspaces", "run-clone"))).toBe(true);
    expect(existsSync(join(root, "workspaces", "run-scratch-kept"))).toBe(true);
    finish();
  });
});
