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

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import echoWorkflow from "../../test/fixtures/echo-workflow";
import { openStore, getRunEvents } from "../persistence/store";
import { createSlowFakeAdapter } from "../replay/adapter";
import { defineWorkflow, Schema } from "../workflow";
import {
  ConcurrencyLimitError,
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

describe("startTrackedRun admission (M1: the slot is reserved before any await)", () => {
  test("a second start while the first is still reserving is refused atomically, and the slot frees after", async () => {
    const { root, finish } = tmpRoot();
    const db = openStore(join(root, "factory.db"));
    const gate = makeGate();

    const first = startTrackedRun(db, echoWorkflow, {
      runId: "run-first",
      dir: join(root, "first-dir"),
      input: {},
      adapter: SLOW_ADAPTER,
      maxConcurrentRuns: 1,
      beforeStart: gate.wait,
    });

    await waitFor(() => activeRunIds().length === 1);
    expect(activeRunIds()).toEqual(["run-first"]);
    expect(getActiveHandle("run-first")).toBeUndefined();

    const second = startTrackedRun(db, echoWorkflow, {
      runId: "run-second",
      dir: join(root, "second-dir"),
      input: {},
      adapter: SLOW_ADAPTER,
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
      startTrackedRun(db, echoWorkflow, {
        runId: "run-doomed",
        input: {},
        adapter: SLOW_ADAPTER,
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

    const runId = await startTrackedRun(db, echoWorkflow, {
      dir: join(root, "dir"),
      input: {},
      adapter: SLOW_ADAPTER,
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

    const starting = startTrackedRun(db, sleepWorkflow, {
      runId: "run-gated",
      dir: join(root, "dir"),
      input: {},
      adapter: SLOW_ADAPTER,
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
