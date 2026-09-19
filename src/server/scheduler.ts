/**
 * The scheduler loop (issue #16). Each schedule in the config fires its
 * workflow's input on its own cron, in the schedule's explicit timezone.
 *
 * The same split as `dispatch.ts` and the deliberate consequence of storing
 * cron strings in config: `tickOnce` is a plain async function over parsed
 * `Cron` objects (Effect's cron value is the internal representation —
 * `Schedule.cron`, the combinator, stays inside the Effect layer), and
 * `runSchedulerLoop` is the thin `Effect.repeat(Schedule.spaced(...))` around
 * it that the daemon forks.
 *
 * Timing model — the decision is `Cron.next(cron, lastTick) <= now`:
 * `lastTick` is initialized to the session's start (createSchedulerState), so
 * windows missed while the process was down are never replayed, and no
 * backlog accumulates within a session either — at most one fire per tick
 * per schedule no matter how many windows a long tick swallows. `lastTick`
 * advances on every tick, past failed and skipped schedules alike, so a
 * suppressed window is not refired later.
 *
 * Overlap: `"skip"` (the default) checks the schedule's dedupe key
 * (`schedule:<id>`, issue #15's registry) and skips the window while a
 * non-terminal run holds it. The fired run itself is started with the same
 * key by the daemon's fire function, which makes the skip observable exactly
 * like any other dedupe collision; `"stack"` fires regardless.
 */

import { Cron, Effect, Schedule, Schema, ManagedRuntime } from "effect";
import type { Database } from "bun:sqlite";
import type { FactoryConfig } from "../config";
import { DedupeKeyError, dedupeRegistry, type DedupeRegistry } from "../lib/dedupe";
import type { WorkflowDefinition } from "../workflow";
import {
  ConcurrencyLimitError,
  DispatchCapError,
  startTrackedRun,
  type DispatchEnv,
  type WorkspaceSpec,
} from "./runs";
import { RunCancelledSignal, type RunRepo } from "../runtime/run";
import { AgentRuntime } from "../runtime/agent-runtime";

export class SchedulerError extends Schema.TaggedError<SchedulerError>()("SchedulerError", {
  cause: Schema.Defect(),
}) {}

/** A config schedule resolved into the runtime's terms: workflow definition in hand, cron parsed. */
export interface RuntimeSchedule {
  readonly id: string;
  readonly workflowId: string;
  readonly workflow: WorkflowDefinition<any, any>;
  readonly input: unknown;
  readonly cron: Cron.Cron;
  readonly overlap: "skip" | "stack";
  readonly runOnStart: boolean;
  readonly agent: { readonly model?: string } | undefined;
}

export function scheduleDedupeKey(schedule: RuntimeSchedule): string {
  return `schedule:${schedule.id}`;
}

/**
 * Issue #17: when the schedule fires next, computed from the stored cron as
 * of `now` — the concrete payoff for keeping cron as a cron string. The same
 * `Cron.next` the loop itself uses, exposed for `GET /api/schedules` and the
 * UI's next-fire display.
 */
export function nextFireAt(schedule: RuntimeSchedule, now: number): number {
  return Cron.next(schedule.cron, new Date(now)).getTime();
}

/** Resolves config's schedules (already validated at load) against the registry and parses each cron. */
export function toRuntimeSchedules(config: FactoryConfig): ReadonlyArray<RuntimeSchedule> {
  return config.schedules.map((schedule) => {
    const workflow = config.workflows.find((w) => w.id === schedule.workflowId);
    if (workflow === undefined) {
      throw new Error(
        `schedule "${schedule.id}" references workflow "${schedule.workflowId}", which is not registered`,
      );
    }
    return {
      id: schedule.id,
      workflowId: schedule.workflowId,
      workflow,
      input: schedule.input,
      cron: Cron.parseUnsafe(schedule.cron, schedule.timezone),
      overlap: schedule.overlap,
      runOnStart: schedule.runOnStart,
      agent: schedule.agent,
    };
  });
}

export interface SchedulerDeps {
  readonly schedules: ReadonlyArray<RuntimeSchedule>;
  /** Starts the scheduled run; the daemon wires it to `startTrackedRun`. */
  readonly fire: (schedule: RuntimeSchedule) => Promise<string>;
  /** Injectable for tests; defaults to the daemon's shared registry. */
  readonly registry?: DedupeRegistry;
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface SchedulerState {
  /** Per schedule: the wall-clock the last tick observed (initialized to session start). */
  readonly lastTick: Map<string, number>;
  /** Schedules still owed their single run-on-start fire this session. */
  readonly runOnStartPending: Set<string>;
}

/**
 * The state a fresh daemon session starts with: `lastTick` = now — the
 * no-catch-up rule — and every `runOnStart` schedule marked pending exactly
 * once per session.
 */
export function createSchedulerState(deps: SchedulerDeps): SchedulerState {
  const now = deps.now?.() ?? Date.now();
  const schedules = deps.schedules;
  return {
    lastTick: new Map(schedules.map((s) => [s.id, now])),
    runOnStartPending: new Set(schedules.filter((s) => s.runOnStart).map((s) => s.id)),
  };
}

export type TickResult =
  | { readonly scheduleId: string; readonly action: "fired"; readonly runId: string }
  | { readonly scheduleId: string; readonly action: "skipped-not-due" }
  | { readonly scheduleId: string; readonly action: "skipped-overlap" }
  | { readonly scheduleId: string; readonly action: "skipped-concurrency" }
  | { readonly scheduleId: string; readonly action: "fire-failed" };

/** The union `deps.fire` is known to throw — the tags a fire failure is classified against. */
type ScheduleFireError =
  | ConcurrencyLimitError
  | DedupeKeyError
  | DispatchCapError
  | RunCancelledSignal;

/** `instanceof`, not an `as` cast, so `err._tag` below is a real literal type. */
function isScheduleFireError(err: unknown): err is ScheduleFireError {
  return (
    err instanceof ConcurrencyLimitError ||
    err instanceof DedupeKeyError ||
    err instanceof DispatchCapError ||
    err instanceof RunCancelledSignal
  );
}

/**
 * Issue #34: the skip-vs-fail split, exhaustive over the known domain-error
 * tags and compiler-checked (the `default` arm's `satisfies never` fails to
 * typecheck if a tag is ever added to `ScheduleFireError` without a case
 * here). Anything outside that union — a non-`Error` throw, or a future
 * error type nobody taught this switch about — still lands in `fire-failed`
 * rather than vanishing: the whole point of the fix.
 */
function classifyFireFailure(err: unknown): "skipped-concurrency" | "fire-failed" {
  if (!isScheduleFireError(err)) return "fire-failed";
  switch (err._tag) {
    case "ConcurrencyLimitError":
      return "skipped-concurrency";
    case "DedupeKeyError":
    case "DispatchCapError":
    case "RunCancelledSignal":
      return "fire-failed";
    default:
      return err satisfies never;
  }
}

/** One scheduler pass over every schedule, in config order. */
export async function tickOnce(
  deps: SchedulerDeps,
  state: SchedulerState,
): Promise<Array<TickResult>> {
  const now = deps.now?.() ?? Date.now();
  const registry = deps.registry ?? dedupeRegistry;
  const results: Array<TickResult> = [];

  for (const schedule of deps.schedules) {
    const lastTick = state.lastTick.get(schedule.id) ?? now;
    state.lastTick.set(schedule.id, now);

    // runOnStart fires on the first tick of the session, before any cron
    // window; once attempted it is consumed whether or not the fire
    // succeeded (the next cron window is the retry, not a second
    // start-fire).
    const onStart = state.runOnStartPending.has(schedule.id);
    if (onStart) state.runOnStartPending.delete(schedule.id);

    const next = Cron.next(schedule.cron, new Date(lastTick));
    if (!onStart && next.getTime() > now) {
      results.push({ scheduleId: schedule.id, action: "skipped-not-due" });
      continue;
    }

    if (schedule.overlap === "skip") {
      const holder = registry.holderOf(scheduleDedupeKey(schedule));
      if (holder !== undefined) {
        results.push({ scheduleId: schedule.id, action: "skipped-overlap" });
        continue;
      }
    }

    try {
      const runId = await deps.fire(schedule);
      results.push({ scheduleId: schedule.id, action: "fired", runId });
    } catch (err) {
      const action = classifyFireFailure(err);
      if (action === "fire-failed") {
        console.error(`[scheduler] schedule "${schedule.id}" fire failed:`, err);
      }
      results.push({ scheduleId: schedule.id, action });
    }
  }

  return results;
}

/** The daemon's scheduler loop — `Effect.repeat` around the plain `tickOnce`. */
export function runSchedulerLoop(
  deps: SchedulerDeps,
  state: SchedulerState,
  intervalMs: number,
): Effect.Effect<unknown> {
  const tick = Effect.gen(function* () {
    const results = yield* Effect.tryPromise({
      try: () => tickOnce(deps, state),
      catch: (cause: unknown) => new SchedulerError({ cause }),
    }).pipe(
      Effect.match({
        onFailure: (error: SchedulerError) => {
          console.error("[scheduler] tick failed:", error.cause);
          return undefined;
        },
        onSuccess: (r) => r,
      }),
    );
    if (results !== undefined) {
      const reportable = results.filter((r) => r.action !== "skipped-not-due");
      if (reportable.length > 0) console.log(`[scheduler] ${JSON.stringify(reportable)}`);
    }
  });
  return Effect.repeat(tick, Schedule.spaced(intervalMs));
}

/**
 * The daemon's fire function: a scheduled run is a config-backed run started
 * like any other — registry input, workspace, dispatch environment — made
 * self-deduping with `schedule:<id>` (issue #15's registry) so the overlap
 * policy and the trigger record both come for free.
 */
export function makeScheduleFire(options: {
  readonly db: Database;
  readonly runtime: ManagedRuntime.ManagedRuntime<AgentRuntime, never>;
  readonly maxConcurrentRuns: number;
  readonly workspace: WorkspaceSpec;
  readonly repo: RunRepo;
  readonly dispatchEnv: DispatchEnv;
}): (schedule: RuntimeSchedule) => Promise<string> {
  const env = options;
  return async (schedule: RuntimeSchedule): Promise<string> => {
    return startTrackedRun(env.runtime, env.db, schedule.workflow, {
      input: schedule.input,
      repo: env.repo,
      maxConcurrentRuns: env.maxConcurrentRuns,
      workspace: env.workspace,
      dispatchEnv: env.dispatchEnv,
      scheduleId: schedule.id,
      ...(schedule.overlap === "skip" ? { dedupeKey: scheduleDedupeKey(schedule) } : {}),
      ...(schedule.agent !== undefined ? { agentOverrides: schedule.agent } : {}),
    });
  };
}
