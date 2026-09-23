/**
 * The scheduler loop (issue #16): each schedule fires on its own cron, at
 * most one fire per tick per schedule (no stacking, no backlog), overlap
 * skipped by default via the schedule's own id as a dedupe key, and no
 * replay of windows the daemon missed while it was down.
 *
 * Driven by an injected Clock (#38): the "due" decision is
 * `Cron.next(cron, lastTick) <= now`, so the cron itself never needs the
 * real clock in a test. The clock comes from Effect's real `TestClock`
 * (`effect/testing`), not a hand-rolled fake — see `createTestClock` below
 * for how it is bridged into `tickOnce`'s plain-async world.
 */

import { describe, expect, test } from "bun:test";
import { Clock, Cron, Effect } from "effect";
import { TestClock } from "effect/testing";
import { createDedupeRegistry } from "../lib/dedupe";
import type { WorkflowDefinition } from "../workflow";
import { ConcurrencyLimitError, DispatchCapError } from "./runs";
import { DedupeKeyError } from "../lib/dedupe";
import {
  createSchedulerState,
  tickOnce,
  type RuntimeSchedule,
  type SchedulerDeps,
} from "./scheduler";

const WORKFLOW: WorkflowDefinition = {
  id: "scheduled-test",
  input: { decodeUnknownSync: () => (input: unknown) => input } as never,
  output: undefined,
  agent: undefined,
  workspace: { kind: "clone" },
  run: (async () => ({})) as never,
};

function schedule(overrides: Partial<RuntimeSchedule> = {}): RuntimeSchedule {
  return {
    id: "nightly",
    workflowId: "scheduled-test",
    workflow: WORKFLOW,
    input: { issueNumber: 1 },
    cron: Cron.parseUnsafe("0 3 * * *", "UTC"),
    overlap: "skip",
    runOnStart: false,
    agent: undefined,
    ...overrides,
  };
}

/**
 * `tickOnce` is deliberately a plain async function (ADR 0009 §5), and it
 * only ever reads the clock synchronously via `currentTimeMillisUnsafe()` —
 * it never suspends on `Effect.sleep`. That means none of `TestClock`'s
 * fiber-coordination machinery (scheduled sleeps, the "hung test" warning
 * fiber) is exercised here; what's needed from it is just a `Clock.Clock`
 * whose time we can move. A real `TestClock` still satisfies that cleanly:
 * `TestClock.make()` is built once per fixture via `Effect.runPromise`, and
 * `setTime` bridges back into the plain-async test body the same way
 * `ManagedRuntime` would for any other Effect service consumed from
 * imperative code.
 */
async function createTestClock(initialTime: number): Promise<{
  clock: Clock.Clock;
  setTime: (t: number) => Promise<void>;
}> {
  const testClock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  await Effect.runPromise(testClock.setTime(initialTime));
  return {
    clock: testClock,
    setTime: (t: number) => Effect.runPromise(testClock.setTime(t)),
  };
}

interface Fixture {
  deps: () => SchedulerDeps;
  readonly fired: Array<string>;
  readonly registry: ReturnType<typeof createDedupeRegistry>;
  readonly fireError: Map<string, unknown>;
  readonly setTime: (t: number) => Promise<void>;
}

async function fixture(schedules: ReadonlyArray<RuntimeSchedule>): Promise<Fixture> {
  const registry = createDedupeRegistry();
  const fired: Array<string> = [];
  const fireError: Map<string, unknown> = new Map();

  const { clock, setTime } = await createTestClock(0);

  const deps: SchedulerDeps = {
    schedules,
    dedupeRegistry: registry,
    clock,
    fire: async (s) => {
      fired.push(s.id);
      const error = fireError.get(s.id);
      if (error !== undefined) throw error;
      return `run-for-${s.id}`;
    },
  };

  return {
    deps: () => deps,
    fired,
    registry,
    fireError,
    setTime,
  };
}

const DAY01_0259 = Date.parse("2026-01-01T02:59:00Z");
const DAY01_0400 = Date.parse("2026-01-01T04:00:00Z");

describe("scheduler tick (issue #16)", () => {
  test("fires when its cron window fell between lastTick and now", async () => {
    const fx = await fixture([schedule()]);
    await fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());

    await fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results).toEqual([{ scheduleId: "nightly", action: "fired", runId: "run-for-nightly" }]);
  });

  test("does not fire twice for the same window across ticks", async () => {
    const fx = await fixture([schedule()]);
    await fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());

    await fx.setTime(DAY01_0400);
    await tickOnce(fx.deps(), state);
    await fx.setTime(DAY01_0400 + 1);
    await tickOnce(fx.deps(), state);

    expect(fx.fired).toEqual(["nightly"]);
  });

  test("skips the window while its previous run still holds the dedupe key (overlap)", async () => {
    const fx = await fixture([schedule()]);
    await fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    fx.registry.claim("schedule:nightly", "run-previous");

    await fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results).toEqual([{ scheduleId: "nightly", action: "skipped-overlap" }]);
    expect(fx.fired).toEqual([]);
  });

  test("overlap: 'stack' fires regardless of the previous run", async () => {
    const fx = await fixture([schedule({ overlap: "stack" })]);
    await fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    fx.registry.claim("schedule:nightly", "run-previous");

    await fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results).toEqual([{ scheduleId: "nightly", action: "fired", runId: "run-for-nightly" }]);
  });

  test("a rejected fire (e.g. concurrency limit) skips the window instead of dying", async () => {
    const fx = await fixture([schedule()]);
    await fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    fx.fireError.set("nightly", new ConcurrencyLimitError({ maxConcurrentRuns: 1 }));

    await fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);
    expect(results).toEqual([{ scheduleId: "nightly", action: "skipped-concurrency" }]);

    fx.fireError.delete("nightly");
    const again = await tickOnce(fx.deps(), state);
    expect(again).toEqual([{ scheduleId: "nightly", action: "skipped-not-due" }]);
  });

  test("windows missed while the daemon was down are not replayed", async () => {
    const fx = await fixture([schedule({ cron: Cron.parseUnsafe("* * * * *", "UTC") })]);
    const start = Date.parse("2026-01-01T12:00:00Z");
    await fx.setTime(start);
    const state = createSchedulerState(fx.deps());

    await fx.setTime(start + 30_000);
    await tickOnce(fx.deps(), state);
    await fx.setTime(start + 3 * 60_000);
    const results = await tickOnce(fx.deps(), state);

    expect(fx.fired).toEqual(["nightly"]);
    expect(results).toEqual([{ scheduleId: "nightly", action: "fired", runId: "run-for-nightly" }]);
  });

  test("runOnStart fires once at scheduler start, before any cron window", async () => {
    const fx = await fixture([schedule({ runOnStart: true })]);
    const state = createSchedulerState(fx.deps());
    expect(state.runOnStartPending).toEqual(new Set(["nightly"]));

    await tickOnce(fx.deps(), state);

    expect(fx.fired).toEqual(["nightly"]);
    expect(state.runOnStartPending).toEqual(new Set());
    const after = await tickOnce(fx.deps(), state);
    expect(after.every((r) => r.action === "skipped-not-due")).toBe(true);
    expect(fx.fired).toEqual(["nightly"]);
  });

  test("an independent schedule is unaffected by another's failure", async () => {
    const fx = await fixture([schedule({ id: "a" }), schedule({ id: "b" })]);
    await fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    fx.fireError.set("a", new Error("boom"));

    await fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results.filter((r) => r.scheduleId === "a")).toEqual([
      { scheduleId: "a", action: "fire-failed" },
    ]);
    expect(results.filter((r) => r.scheduleId === "b")).toEqual([
      { scheduleId: "b", action: "fired", runId: "run-for-b" },
    ]);
  });

  test("each domain error type is explicitly classified (exhaustive match, #34)", async () => {
    const concurrencyFx = await fixture([schedule({ id: "conc" })]);
    await concurrencyFx.setTime(DAY01_0259);
    const concurrencyState = createSchedulerState(concurrencyFx.deps());
    concurrencyFx.fireError.set("conc", new ConcurrencyLimitError({ maxConcurrentRuns: 1 }));
    await concurrencyFx.setTime(DAY01_0400);
    expect(await tickOnce(concurrencyFx.deps(), concurrencyState)).toEqual([
      { scheduleId: "conc", action: "skipped-concurrency" },
    ]);

    const dedupeFx = await fixture([schedule({ id: "dedupe" })]);
    await dedupeFx.setTime(DAY01_0259);
    const dedupeState = createSchedulerState(dedupeFx.deps());
    dedupeFx.fireError.set(
      "dedupe",
      new DedupeKeyError({ key: "schedule:dedupe", holderRunId: "run-x" }),
    );
    await dedupeFx.setTime(DAY01_0400);
    expect(await tickOnce(dedupeFx.deps(), dedupeState)).toEqual([
      { scheduleId: "dedupe", action: "fire-failed" },
    ]);

    const capFx = await fixture([schedule({ id: "cap" })]);
    await capFx.setTime(DAY01_0259);
    const capState = createSchedulerState(capFx.deps());
    capFx.fireError.set("cap", new DispatchCapError({ message: "depth exceeded" }));
    await capFx.setTime(DAY01_0400);
    expect(await tickOnce(capFx.deps(), capState)).toEqual([
      { scheduleId: "cap", action: "fire-failed" },
    ]);
  });

  test("a tagged error the match doesn't recognize still lands in fire-failed, not dropped (#34)", async () => {
    // The regression this guards: a real bug had the switch fall through
    // silently for any `_tag` outside its four known cases, so a schedule
    // whose fire failed with an unrecognized tagged error got zero entries
    // in `results` instead of one — worse than the wrong bucket, an outright
    // vanished tick.
    class UnknownTaggedError extends Error {
      readonly _tag = "SomeFutureDomainError";
    }
    const fx = fixture([schedule()]);
    fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    fx.fireError.set("nightly", new UnknownTaggedError("mystery failure"));

    fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results).toEqual([{ scheduleId: "nightly", action: "fire-failed" }]);
  });
});
