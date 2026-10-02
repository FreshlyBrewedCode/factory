/**
 * `factory serve` — wires the HTTP API/SSE (`server/http.ts`) and the config
 * scheduler (`server/scheduler.ts`) into one running process (AGENTS.md's
 * third column). Automatic dispatch is not daemon logic since epic #19: it
 * is project policy living in scheduled wrapper workflows — e.g. the sample
 * project's Ready sweep — fired by the scheduler loop on their cron.
 *
 * Issue #36: this is the daemon's Effect composition root. It builds the
 * agent runtime's `ManagedRuntime` once and hands it to `serve()` and the
 * scheduler; the adapter is resolved from that runtime's context inside
 * `runtime/agent-step.ts` instead of being threaded through every options
 * type. `DaemonHandle.stop` disposes it.
 *
 * #38: that runtime is the daemon runtime (`server/daemon-runtime.ts`): the
 * agent runtime layer composed with the per-daemon state layers (run
 * registry, pubsub, dedupe registry, refresh gates). Building it builds fresh
 * state, so two daemons are two runtimes and coexist in one process without
 * sharing anything. The scheduler loop is forked on it and resolves its
 * dedupe registry and clock from its context.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Fiber } from "effect";
type AnyFiber = Fiber.Fiber<unknown, unknown>;
import type { FactoryConfig } from "../config";
import { openStore } from "../persistence/store";
import { serve } from "./http";
import type { DispatchEnv, WorkspaceSpec } from "./runs";
import { makeScheduleFire, runSchedulerLoop, toRuntimeSchedules } from "./scheduler";
import { makeDaemonRuntime, type DaemonRuntime } from "./daemon-runtime";

export interface DaemonOptions {
  readonly dbPath: string;
  readonly port?: number;
  /** Issue #16: the tick cadence of the config schedules, over the default. */
  readonly schedulerIntervalMs?: number;
  /**
   * The run environment from `factory.config.ts` (D27). Present, every run —
   * manual and scheduled alike — gets a per-run working tree under the
   * configured `workspaceRoot` (D28) and shares one admission limit (D29).
   * Absent, the legacy per-request `{dir, clone}` behaviour is kept.
   */
  readonly config?: FactoryConfig;
}

export interface DaemonHandle {
  readonly server: ReturnType<typeof serve>;
  /** Issue #16: the loop that fires the config's schedules, when it has any. */
  readonly schedulerFiber: AnyFiber | undefined;
  /**
   * Issue #38: this daemon's runtime — its agent runtime plus its own
   * registry, pubsub, dedupe registry and refresh gates, resolvable with
   * `serviceOf`.
   */
  readonly runtime: DaemonRuntime;
  /**
   * Shut the daemon down: interrupt the scheduler, stop the HTTP server, and
   * dispose the agent runtime (issue #36).
   */
  readonly stop: () => Promise<void>;
}

/** Issue #16: how often the scheduler's due window check runs. */
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  await mkdir(dirname(options.dbPath), { recursive: true });
  const db = openStore(options.dbPath);

  const runtime = makeDaemonRuntime(options.config?.agent.adapter);

  const server = serve({
    db,
    runtime,
    port: options.port,
    ...(options.config !== undefined ? { config: options.config } : {}),
  });

  const schedulerFiber: AnyFiber | undefined =
    options.config !== undefined && options.config.schedules.length > 0
      ? (() => {
          const config = options.config!;
          const workspace: WorkspaceSpec = {
            workspaceRoot: config.workspaceRoot,
            sshUrl: config.repo.sshUrl,
            identity: config.repo.identity,
            retainedWorkspaces: config.retainedWorkspaces,
          };
          const repo = { slug: config.repo.slug, baseBranch: config.repo.baseBranch };
          const maxConcurrentRuns = config.maxConcurrentRuns;
          const dispatchEnv: DispatchEnv = {
            workspace,
            repo,
            maxConcurrentRuns,
            maxDispatchDepth: config.maxDispatchDepth,
            maxChildrenPerRun: config.maxChildrenPerRun,
          };
          const fire = makeScheduleFire({
            db,
            runtime,
            maxConcurrentRuns,
            workspace,
            repo,
            dispatchEnv,
          });
          return runtime.runFork(
            runSchedulerLoop(
              toRuntimeSchedules(config),
              fire,
              options.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
            ),
          );
        })()
      : undefined;

  const stop = async (): Promise<void> => {
    if (schedulerFiber !== undefined) await Effect.runPromise(Fiber.interrupt(schedulerFiber));
    await server.stop(true);
    await runtime.dispose();
  };

  return { server, schedulerFiber, runtime, stop };
}
