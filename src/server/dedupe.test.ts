/**
 * Issue #15, server side: `startTrackedRun` claims its `dedupeKey` before any
 * await (so a concurrent start with the same key cannot lose the race) and
 * releases it when the run reaches any terminal state. Starting a second run
 * with a key a non-terminal run already holds throws a `DedupeKeyError`
 * naming the key and the holding run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openStore, getRunEvents } from "../persistence/store";
import { createSlowFakeAdapter } from "../replay/adapter";
import { defineWorkflow, Schema } from "../workflow";
import { createDedupeRegistry, DedupeKeyError } from "../lib/dedupe";
import { isActive, startTrackedRun } from "./runs";

const SLOW_ADAPTER = createSlowFakeAdapter(
  [
    { type: "TEXT_MESSAGE_START" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
    { type: "TEXT_MESSAGE_END" },
  ],
  25,
);

const echoWorkflow = defineWorkflow("echo-wf", {
  input: Schema.Struct({}),
  run: async (ctx) => {
    const result = await ctx.agent("step", "irrelevant, replay ignores it");
    return { finalText: result.finalText };
  },
});

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

interface StartOpts {
  readonly runId?: string;
  readonly dir: string;
  readonly dedupeKey?: string;
  readonly beforeStart?: () => Promise<void>;
  /** Shared holder registry when one test needs two starts to agree. */
  readonly registry?: ReturnType<typeof createDedupeRegistry>;
}

function start(db: ReturnType<typeof openStore>, opts: StartOpts): Promise<string> {
  return startTrackedRun(db, echoWorkflow, {
    dir: opts.dir,
    input: {},
    adapter: SLOW_ADAPTER,
    dedupeRegistry: opts.registry ?? createDedupeRegistry(),
    maxConcurrentRuns: 4,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
    ...(opts.beforeStart !== undefined ? { beforeStart: opts.beforeStart } : {}),
  });
}

/** The `DedupeKeyError` a rejected start produced — else a placeholder string. */
async function errorOf(promise: Promise<string>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (err: unknown) => err,
  );
}

describe("dedupe keys through startTrackedRun (issue #15)", () => {
  test("a key held by a non-terminal run rejects a second start with key and holder named", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-hold-"));
    const db = openStore(join(root, "factory.db"));
    const gate = makeGate();
    const registry = createDedupeRegistry();

    const first = start(db, {
      runId: "run-holder",
      dir: join(root, "dir-1"),
      dedupeKey: "item:41",
      beforeStart: gate.wait,
      registry,
    });
    await waitFor(() => isActive("run-holder"));

    const err = (await errorOf(
      start(db, { runId: "run-collide", dir: join(root, "dir-2"), dedupeKey: "item:41", registry }),
    )) as
      | DedupeKeyError
      | string;
    expect(err).toBeInstanceOf(DedupeKeyError);
    if (err instanceof DedupeKeyError) {
      expect(err.key).toBe("item:41");
      expect(err.holderRunId).toBe("run-holder");
      expect(err.message).toContain("item:41");
      expect(err.message).toContain("run-holder");
    }

    gate.release();
    await first;
    await waitFor(() => !isActive("run-holder"));

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the holder's RunStarted carries the key; a rejected start leaves no lifecycle trace", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-log-"));
    const db = openStore(join(root, "factory.db"));
    const gate = makeGate();
    const registry = createDedupeRegistry();

    const first = start(db, {
      runId: "run-holder",
      dir: join(root, "dir-1"),
      dedupeKey: "item:42",
      beforeStart: gate.wait,
      registry,
    });
    await waitFor(() => isActive("run-holder"));

    await errorOf(
      start(db, { runId: "run-collide", dir: join(root, "dir-2"), dedupeKey: "item:42", registry }),
    );

    gate.release();
    await first;
    await waitFor(() => !isActive("run-holder"));

    const holderStarted = getRunEvents(db, "run-holder").find((e) => e.payload._tag === "RunStarted");

    expect(holderStarted !== undefined && holderStarted.payload._tag === "RunStarted").toBe(true);
    expect(
      holderStarted !== undefined && holderStarted.payload._tag === "RunStarted"
        ? holderStarted.payload.dedupeKey
        : "missing",
    ).toBe("item:42");
    // A dropped start never started: the collision run's log has no rows.
    expect(getRunEvents(db, "run-collide")).toHaveLength(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the key is released when the holding run reaches its terminal state", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-finish-"));
    const db = openStore(join(root, "factory.db"));

    const firstRunId = await start(db, { dir: join(root, "dir-1"), dedupeKey: "item:43" });
    expect(firstRunId).toBeTypeOf("string");
    await waitFor(() => !isActive(firstRunId));

    const retryRunId = await start(db, { dir: join(root, "dir-2"), dedupeKey: "item:43" });
    await waitFor(() => !isActive(retryRunId));
    expect(getRunEvents(db, retryRunId).some((e) => e.payload._tag === "RunStarted")).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a failed start releases its claim so a corrected retry can start", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-fail-"));
    const db = openStore(join(root, "factory.db"));

    // allocation of an explicitly undefined dir fails after the claim
    await expect(
      startTrackedRun(db, echoWorkflow, {
        input: {},
        adapter: SLOW_ADAPTER,
        dedupeKey: "item:44",
        dedupeRegistry: createDedupeRegistry(),
      }),
    ).rejects.toThrow(/needs `dir` or `workspace`/);

    const retryRunId = await start(db, { dir: join(root, "dir-1"), dedupeKey: "item:44" });
    await waitFor(() => !isActive(retryRunId));
    expect(getRunEvents(db, retryRunId).some((e) => e.payload._tag === "RunStarted")).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("runs started without a key behave exactly as before", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-none-"));
    const db = openStore(join(root, "factory.db"));

    const firstRunId = await start(db, { dir: join(root, "dir-1") });
    const secondRunId = await start(db, { dir: join(root, "dir-2") });
    expect(firstRunId).toBeTypeOf("string");
    expect(secondRunId).toBeTypeOf("string");
    await waitFor(() => !isActive(firstRunId) && !isActive(secondRunId));

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
