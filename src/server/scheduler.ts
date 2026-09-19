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
 *
 * #38: the clock comes from Effect's Clock service. Tests use TestClock or
 * provide a custom Clock instance rather than an injected `now` function.
 */

import { Clock, Cron, Effect, Schedule, Schema } from "effect";
import type { Database } from "bun:sqlite";
import type { FactoryConfig } from "../config";
import type { DedupeRegistry } from "../lib/dedupe";
import type { WorkflowDefinition } from "../workflow";
import {
  startTrackedRun,
  ConcurrencyLimitError,
  type DaemonServices,
  type DispatchEnv,
  type WorkspaceSpec,
} from "./runs";
import type { RunRepo } from "../runtime/run";
import type { AgentAdapter } from "../runtime/agent-adapter";

export class SchedulerError extends Schema.TaggedError<SchedulerError>()("SchedulerError", {
  cause: Schema.Defect(),
}) {}

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

export function nextFireAt(schedule: RuntimeSchedule, now: number): number {
  return Cron.next(schedule.cron, new Date(now)).getTime();
}

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
  readonly fire: (schedule: RuntimeSchedule) => Promise<string>;
  readonly dedupeRegistry: DedupeRegistry;
  readonly clock: Clock.Clock;
}

export interface SchedulerState {
  readonly lastTick: Map<string, number>;
  readonly runOnStartPending: Set<string>;
}

export function createSchedulerState(deps: SchedulerDeps): SchedulerState {
  const now = deps.clock.currentTimeMillisUnsafe();
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

export async function tickOnce(
  deps: SchedulerDeps,
  state: SchedulerState,
): Promise<Array<TickResult>> {
  const now = deps.clock.currentTimeMillisUnsafe();
  const registry = deps.dedupeRegistry;
  const results: Array<TickResult> = [];

  for (const schedule of deps.schedules) {
    const lastTick = state.lastTick.get(schedule.id) ?? now;
    state.lastTick.set(schedule.id, now);

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
      if (err instanceof ConcurrencyLimitError) {
        results.push({ scheduleId: schedule.id, action: "skipped-concurrency" });
      } else {
        console.error(`[scheduler] schedule "${schedule.id}" fire failed:`, err);
        results.push({ scheduleId: schedule.id, action: "fire-failed" });
      }
    }
  }

  return results;
}

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

export function makeScheduleFire(options: {
  readonly db: Database;
  readonly services: DaemonServices;
  readonly adapter: AgentAdapter;
  readonly maxConcurrentRuns: number;
  readonly workspace: WorkspaceSpec;
  readonly repo: RunRepo;
  readonly dispatchEnv: DispatchEnv;
}): (schedule: RuntimeSchedule) => Promise<string> {
  const env = options;
  return async (schedule: RuntimeSchedule): Promise<string> => {
    return startTrackedRun(env.db, env.services, schedule.workflow, {
      input: schedule.input,
      repo: env.repo,
      adapter: options.adapter,
      maxConcurrentRuns: options.maxConcurrentRuns,
      workspace: env.workspace,
      dispatchEnv: env.dispatchEnv,
      scheduleId: schedule.id,
      ...(schedule.overlap === "skip" ? { dedupeKey: scheduleDedupeKey(schedule) } : {}),
      ...(schedule.agent !== undefined ? { agentOverrides: schedule.agent } : {}),
    });
  };
}
