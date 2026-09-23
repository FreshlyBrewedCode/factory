/**
 * The scheduler loop (issue #16): each schedule fires on its own cron, at
 * most one fire per tick per schedule (no stacking, no backlog), overlap
 * skipped by default via the schedule's own id as a dedupe key, and no
 * replay of windows the daemon missed while it was down.
 *
 * Driven entirely by injected wall-clock (`deps.now`): the "due" decision is
 * `Cron.next(cron, lastTick) <= now`, so the cron itself never needs the
 * real clock in a test.
 */

import { describe, expect, test } from "bun:test";
import { Cron } from "effect";
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

interface Fixture {
  deps: () => SchedulerDeps;
  readonly fired: Array<string>;
  readonly registry: ReturnType<typeof createDedupeRegistry>;
  /** Per-schedule injected fire failures. */
  readonly fireError: Map<string, unknown>;
  /** The fixture's injectable clock. */
  readonly setTime: (t: number) => void;
}

function fixture(schedules: ReadonlyArray<RuntimeSchedule>): Fixture {
  const registry = createDedupeRegistry();
  const fired: Array<string> = [];
  // Per-schedule injected fire failures.
  const fireError: Map<string, unknown> = new Map();

  let now = 0;
  const deps: SchedulerDeps = {
    schedules,
    registry,
    fire: async (s) => {
      fired.push(s.id);
      const error = fireError.get(s.id);
      if (error !== undefined) throw error;
      return `run-for-${s.id}`;
    },
    now: () => now,
  };

  return {
    deps: () => deps,
    fired,
    registry,
    fireError,
    setTime: (t: number) => (now = t),
  };
}

const DAY01_0259 = Date.parse("2026-01-01T02:59:00Z");
const DAY01_0400 = Date.parse("2026-01-01T04:00:00Z");

describe("scheduler tick (issue #16)", () => {
  test("fires when its cron window fell between lastTick and now", async () => {
    const fx = fixture([schedule()]);
    // state created before the window (03:05), tick after it (04:00)
    fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());

    fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results).toEqual([{ scheduleId: "nightly", action: "fired", runId: "run-for-nightly" }]);
  });

  test("does not fire twice for the same window across ticks", async () => {
    const fx = fixture([schedule()]);
    fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());

    fx.setTime(DAY01_0400);
    await tickOnce(fx.deps(), state);
    fx.setTime(DAY01_0400 + 1);
    await tickOnce(fx.deps(), state);

    expect(fx.fired).toEqual(["nightly"]);
  });

  test("skips the window while its previous run still holds the dedupe key (overlap)", async () => {
    const fx = fixture([schedule()]);
    fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    // A previous run of this schedule is still going.
    fx.registry.claim("schedule:nightly", "run-previous");

    fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results).toEqual([{ scheduleId: "nightly", action: "skipped-overlap" }]);
    expect(fx.fired).toEqual([]);
  });

  test("overlap: 'stack' fires regardless of the previous run", async () => {
    const fx = fixture([schedule({ overlap: "stack" })]);
    fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    fx.registry.claim("schedule:nightly", "run-previous");

    fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results).toEqual([{ scheduleId: "nightly", action: "fired", runId: "run-for-nightly" }]);
  });

  test("a rejected fire (e.g. concurrency limit) skips the window instead of dying", async () => {
    const fx = fixture([schedule()]);
    fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    fx.fireError.set("nightly", new ConcurrencyLimitError({ maxConcurrentRuns: 1 }));

    fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);
    expect(results).toEqual([{ scheduleId: "nightly", action: "skipped-concurrency" }]);

    // lastTick advanced regardless: the missed window is not refired later.
    fx.fireError.delete("nightly");
    const again = await tickOnce(fx.deps(), state);
    expect(again).toEqual([{ scheduleId: "nightly", action: "skipped-not-due" }]);
  });

  test("windows missed while the daemon was down are not replayed", async () => {
    // Every-minute cron, three windows pass between two ticks after the
    // daemon "came up": one fire, not three — and the pre-start windows
    // (12:00:00–12:00:30 before the state existed) never fire at all.
    const fx = fixture([schedule({ cron: Cron.parseUnsafe("* * * * *", "UTC") })]);
    const start = Date.parse("2026-01-01T12:00:00Z");
    fx.setTime(start);
    const state = createSchedulerState(fx.deps());

    fx.setTime(start + 30_000);
    await tickOnce(fx.deps(), state);
    fx.setTime(start + 3 * 60_000);
    const results = await tickOnce(fx.deps(), state);

    expect(fx.fired).toEqual(["nightly"]);
    expect(results).toEqual([{ scheduleId: "nightly", action: "fired", runId: "run-for-nightly" }]);
  });

  test("runOnStart fires once at scheduler start, before any cron window", async () => {
    const fx = fixture([schedule({ runOnStart: true })]);
    const state = createSchedulerState(fx.deps());
    expect(state.runOnStartPending).toEqual(new Set(["nightly"]));

    await tickOnce(fx.deps(), state);

    expect(fx.fired).toEqual(["nightly"]);
    expect(state.runOnStartPending).toEqual(new Set());
    // Pending is consumed whether or not the fire succeeded.
    const after = await tickOnce(fx.deps(), state);
    expect(after.every((r) => r.action === "skipped-not-due")).toBe(true);
    expect(fx.fired).toEqual(["nightly"]);
  });

  test("an independent schedule is unaffected by another's failure", async () => {
    const fx = fixture([schedule({ id: "a" }), schedule({ id: "b" })]);
    fx.setTime(DAY01_0259);
    const state = createSchedulerState(fx.deps());
    fx.fireError.set("a", new Error("boom"));

    fx.setTime(DAY01_0400);
    const results = await tickOnce(fx.deps(), state);

    expect(results.filter((r) => r.scheduleId === "a")).toEqual([
      { scheduleId: "a", action: "fire-failed" },
    ]);
    expect(results.filter((r) => r.scheduleId === "b")).toEqual([
      { scheduleId: "b", action: "fired", runId: "run-for-b" },
    ]);
  });

  test("each domain error type is explicitly classified (exhaustive match, #34)", async () => {
    const concurrencyFx = fixture([schedule({ id: "conc" })]);
    concurrencyFx.setTime(DAY01_0259);
    const concurrencyState = createSchedulerState(concurrencyFx.deps());
    concurrencyFx.fireError.set("conc", new ConcurrencyLimitError({ maxConcurrentRuns: 1 }));
    concurrencyFx.setTime(DAY01_0400);
    expect(await tickOnce(concurrencyFx.deps(), concurrencyState)).toEqual([
      { scheduleId: "conc", action: "skipped-concurrency" },
    ]);

    const dedupeFx = fixture([schedule({ id: "dedupe" })]);
    dedupeFx.setTime(DAY01_0259);
    const dedupeState = createSchedulerState(dedupeFx.deps());
    dedupeFx.fireError.set(
      "dedupe",
      new DedupeKeyError({ key: "schedule:dedupe", holderRunId: "run-x" }),
    );
    dedupeFx.setTime(DAY01_0400);
    expect(await tickOnce(dedupeFx.deps(), dedupeState)).toEqual([
      { scheduleId: "dedupe", action: "fire-failed" },
    ]);

    const capFx = fixture([schedule({ id: "cap" })]);
    capFx.setTime(DAY01_0259);
    const capState = createSchedulerState(capFx.deps());
    capFx.fireError.set("cap", new DispatchCapError({ message: "depth exceeded" }));
    capFx.setTime(DAY01_0400);
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
