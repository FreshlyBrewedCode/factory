/**
 * M1/L1 review fixes, against the registry the server actually uses:
 *
 * - an admitted run reserves its registry slot *before* any await (M1) —
 *   check-then-set with no await gap, so a concurrent start cannot lose the
 *   race; the slot is released when allocation/startup throws.
 * - a `cancel` arriving while a run is only a reserved slot is deferred into
 *   run start (L1): the run starts, is cancelled immediately, and ends as a
 *   clean RunCancelled with no orphaned slot.
 *
 * #38: each test builds its own daemon runtime (`createTestDaemon`) instead
 * of sharing module-level singletons. The reserved-but-not-started window is held open by pre-seeding
 * the daemon's refresh gate for the workspace mirror, so allocation blocks
 * until the test releases it.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../events";
import type { AgentAdapter } from "../runtime/agent-adapter";
import echoWorkflow from "../../test/fixtures/echo-workflow";
import { appendEvent, openStore, getRunEvents } from "../persistence/store";
import { createSlowFakeAdapter } from "../replay/adapter";
import { defineWorkflow, Schema } from "../workflow";
import {
  ConcurrencyLimitError,
  DispatchCapError,
  startTrackedRun,
  type WorkspaceSpec,
} from "./runs";
import { createTestDaemon, type TestDaemon } from "./test-daemon";

const SLOW_ADAPTER = createSlowFakeAdapter(
  [
    { type: "TEXT_MESSAGE_START" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
    { type: "TEXT_MESSAGE_END" },
  ],
  25,
);

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
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function makeGate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A clone workspace whose allocation blocks until `gate` is released: the
 * gate is pre-seeded as the mirror's in-flight refresh, so `allocateWorkspace`
 * queues behind it — the run holds a reserved slot and nothing more.
 */
async function gatedWorkspace(
  root: string,
  daemon: TestDaemon,
  gate: Gate,
): Promise<WorkspaceSpec> {
  const seed = join(root, "seed");
  await Bun.$`git init -b main -q ${seed}`.quiet();
  await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q --allow-empty -m seed`.quiet();
  const workspaceRoot = join(root, "workspaces");
  daemon.refreshGates.set(join(workspaceRoot, ".mirror.git"), gate.promise);
  return {
    workspaceRoot,
    sshUrl: seed,
    identity: { name: "T", email: "t@t.test" },
    retainedWorkspaces: 10,
  };
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
    const err = ConcurrencyLimitError.of({ maxConcurrentRuns: 5 });
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

  test("ConcurrencyLimitError constructs its message, so the stack header names it", () => {
    const err = ConcurrencyLimitError.of({ maxConcurrentRuns: 5 });
    expect(err.message).toBe("concurrency limit reached (max 5 concurrent runs)");
    expect(err.stack?.split("\n")[0]).toBe(`ConcurrencyLimitError: ${err.message}`);
  });
});

describe("startTrackedRun admission (M1: the slot is reserved before any await)", () => {
  test("a second start while the first is still reserving is refused atomically, and the slot frees after", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const daemon = createTestDaemon(SLOW_ADAPTER);
    const gate = makeGate();

    const first = startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-first",
      workspace: await gatedWorkspace(root, daemon, gate),
      input: {},
      maxConcurrentRuns: 1,
    });

    await waitFor(() => daemon.registry.activeRunIds().length === 1);
    expect(daemon.registry.activeRunIds()).toEqual(["run-first"]);
    expect(daemon.registry.getActiveHandle("run-first")).toBeUndefined();

    const second = startTrackedRun(daemon.runtime, db, echoWorkflow, {
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
    await waitFor(() => !daemon.registry.isActive(firstRunId));
    expect(daemon.registry.activeRunIds()).toEqual([]);

    db.close();
    finish();
  });

  test("a second start issued synchronously, before the first is awaited, is refused", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const daemon = createTestDaemon(SLOW_ADAPTER);
    const gate = makeGate();
    const workspace = await gatedWorkspace(root, daemon, gate);

    // No await between the two calls: the first must already hold its slot.
    const first = startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-sync-first",
      workspace,
      input: {},
      maxConcurrentRuns: 1,
    });
    const second = startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-sync-second",
      workspace,
      input: {},
      maxConcurrentRuns: 1,
    });

    expect(await second.catch((err: unknown) => err)).toBeInstanceOf(ConcurrencyLimitError);
    expect(daemon.registry.activeRunIds()).toEqual(["run-sync-first"]);

    gate.release();
    const firstRunId = await first;
    await waitFor(() => !daemon.registry.isActive(firstRunId));

    db.close();
    finish();
  });

  test("a second start with the same runId while the first is still reserving is refused", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const daemon = createTestDaemon(SLOW_ADAPTER);
    const gate = makeGate();
    const workspace = await gatedWorkspace(root, daemon, gate);

    // No limit, so admission cannot be what refuses it: the reserved slot is.
    const first = startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-same-id",
      workspace,
      input: {},
    });
    const second = startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-same-id",
      workspace,
      input: {},
    });

    const err = await second.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("already active");
    expect(daemon.registry.activeRunIds()).toEqual(["run-same-id"]);

    gate.release();
    await first;
    await waitFor(() => !daemon.registry.isActive("run-same-id"));

    db.close();
    finish();
  });

  test("a start refused at the limit does not keep its dedupe key", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const daemon = createTestDaemon(SLOW_ADAPTER);
    const gate = makeGate();

    const first = startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-holding-slot",
      workspace: await gatedWorkspace(root, daemon, gate),
      input: {},
      maxConcurrentRuns: 1,
    });

    // e.g. a scheduled fire with `overlap: "skip"` while the daemon is full.
    const refused = startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-refused",
      dir: join(root, "refused-dir"),
      input: {},
      maxConcurrentRuns: 1,
      dedupeKey: "schedule:nightly",
    });
    expect(await refused.catch((err: unknown) => err)).toBeInstanceOf(ConcurrencyLimitError);
    expect(daemon.dedupeRegistry.holderOf("schedule:nightly")).toBeUndefined();

    gate.release();
    const firstRunId = await first;
    await waitFor(() => !daemon.registry.isActive(firstRunId));

    db.close();
    finish();
  });

  test("a failed allocation releases the reserved slot", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const daemon = createTestDaemon(SLOW_ADAPTER);

    await expect(
      startTrackedRun(daemon.runtime, db, echoWorkflow, {
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

    expect(daemon.registry.activeRunIds()).toEqual([]);

    const runId = await startTrackedRun(daemon.runtime, db, echoWorkflow, {
      dir: join(root, "dir"),
      input: {},
      maxConcurrentRuns: 1,
    });
    expect(daemon.registry.activeRunIds()).toEqual([runId]);
    await waitFor(() => !daemon.registry.isActive(runId));

    db.close();
    finish();
  });
});

describe("cancel of a reserved-but-not-started run (L1)", () => {
  test("cancelling during the allocation window defers into run start; the run ends cancelled with no leak", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const daemon = createTestDaemon(SLOW_ADAPTER);
    const gate = makeGate();

    const starting = startTrackedRun(daemon.runtime, db, sleepWorkflow, {
      runId: "run-gated",
      workspace: await gatedWorkspace(root, daemon, gate),
      input: {},
      maxConcurrentRuns: 1,
    });

    await waitFor(() => daemon.registry.activeRunIds().length === 1);
    expect(daemon.registry.getActiveHandle("run-gated")).toBeUndefined();

    const cancelled = daemon.registry.cancelRegisteredRun("run-gated");
    expect(cancelled).toEqual({ kind: "reserved" });

    gate.release();
    const runId = await starting;
    expect(runId).toBe("run-gated");

    await waitFor(() => daemon.registry.activeRunIds().length === 0);
    const events = getRunEvents(db, runId).map((e) => e.payload._tag);
    expect(events).toContain("RunStarted");
    expect(events).toContain("RunCancelled");
    expect(daemon.registry.cancelRegisteredRun(runId)).toBeUndefined();

    await Bun.sleep(50);
    expect(daemon.registry.activeRunIds()).toEqual([]);

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
    const daemon = createTestDaemon(SLOW_ADAPTER);
    mkdirSync(join(root, "seed"), { recursive: true });

    const runId = await startTrackedRun(daemon.runtime, db, failingScratchWorkflow, {
      runId: "run-scratch-empty",
      workspace: { ...workspaceSpec(), sshUrl: join(root, "no-such-remote") },
      input: {},
    });
    await waitFor(() => !daemon.registry.isActive(runId));

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
    const daemon = createTestDaemon(SLOW_ADAPTER);
    mkdirSync(join(root, "seed"), { recursive: true });

    const okId = await startTrackedRun(daemon.runtime, db, scratchWorkflow, {
      runId: "run-scratch-ok",
      workspace: workspaceSpec(),
      input: {},
    });
    await waitFor(() => !daemon.registry.isActive(okId));
    await new Promise((resolve) => setTimeout(resolve, 50)); // reap lands async
    expect(existsSync(join(root, "workspaces", "run-scratch-ok"))).toBe(false);

    const badId = await startTrackedRun(daemon.runtime, db, failingScratchWorkflow, {
      runId: "run-scratch-bad",
      workspace: workspaceSpec(),
      input: {},
    });
    await waitFor(() => !daemon.registry.isActive(badId));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(root, "workspaces", "run-scratch-bad"))).toBe(true);
    finish();
  });

  test("a scratch leftover does not evict clone workspaces from retention", async () => {
    const { root, finish } = tmpRoot();
    _tmp = root;
    const db = openStore(join(root, "factory.db"));
    const daemon = createTestDaemon(SLOW_ADAPTER);
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
    await startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-clone",
      workspace: { ...workspaceSpec(), sshUrl: seed, retainedWorkspaces: 1 },
      input: {},
    });
    await waitFor(() => !daemon.registry.isActive("run-clone"));

    expect(existsSync(join(root, "workspaces", "run-clone"))).toBe(true);
    expect(existsSync(join(root, "workspaces", "run-scratch-kept"))).toBe(true);
    finish();
  });
});

/**
 * #37 / #24: the adapter prepares only workspaces the daemon cloned. A clone
 * the daemon allocated must reach `adapter.prepareWorkspace` (or the opencode
 * sandbox deadlocks on a permission ask nobody answers); a scratch tree must not.
 */
describe("adapter.prepareWorkspace through startTrackedRun (#37)", () => {
  function trackingAdapter(): AgentAdapter & { readonly prepared: Array<string> } {
    const prepared: Array<string> = [];
    const inner = createSlowFakeAdapter([]);
    return {
      prepared,
      async prepareWorkspace(dir: string): Promise<void> {
        prepared.push(dir);
      },
      stream: inner.stream.bind(inner),
    };
  }

  const scratchWorkflow = defineWorkflow("prep-scratch-test", {
    input: Schema.Struct({}),
    workspace: { kind: "scratch" },
    run: async () => ({}),
  });

  test("an allocated clone workspace is prepared on the allocated dir", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const adapter = trackingAdapter();
    const seed = join(root, "seed");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    const daemon = createTestDaemon(adapter);

    const runId = await startTrackedRun(daemon.runtime, db, echoWorkflow, {
      runId: "run-prep-clone",
      workspace: {
        workspaceRoot: join(root, "workspaces"),
        sshUrl: seed,
        identity: { name: "Test Bot", email: "test@factory.local" },
        retainedWorkspaces: 10,
      },
      input: {},
    });
    await waitFor(() => !daemon.registry.isActive(runId));

    expect(adapter.prepared).toEqual([join(root, "workspaces", "run-prep-clone")]);
    finish();
  });

  test("a scratch workspace is not prepared", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const adapter = trackingAdapter();
    const daemon = createTestDaemon(adapter);

    const runId = await startTrackedRun(daemon.runtime, db, scratchWorkflow, {
      runId: "run-prep-scratch",
      workspace: {
        workspaceRoot: join(root, "workspaces"),
        sshUrl: join(root, "no-such-remote"),
        identity: { name: "Test Bot", email: "test@factory.local" },
        retainedWorkspaces: 10,
      },
      input: {},
    });
    await waitFor(() => !daemon.registry.isActive(runId));

    expect(adapter.prepared).toEqual([]);
    finish();
  });
});
