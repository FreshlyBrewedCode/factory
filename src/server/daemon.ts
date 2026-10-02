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
 * #38: the daemon creates per-instance services (run registry, pubsub,
 * dedupe registry, refresh gates) so two daemons can coexist in one process
 * without sharing state.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Clock, Effect, Fiber } from "effect";
type AnyFiber = Fiber.Fiber<unknown, unknown>;
import type { FactoryConfig } from "../config";
import { openStore } from "../persistence/store";
import { serve } from "./http";
import {
  createRunRegistry,
  type DaemonServices,
  type DispatchEnv,
  type WorkspaceSpec,
} from "./runs";
import { createPubSub } from "./pubsub";
import { createDedupeRegistry } from "../lib/dedupe";
import { createRefreshGates } from "../lib/workspace";
import {
  createSchedulerState,
  makeScheduleFire,
  runSchedulerLoop,
  toRuntimeSchedules,
  type SchedulerDeps,
} from "./scheduler";
import { makeAgentRuntime } from "../runtime/agent-runtime";

export function createLiveClock(): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => Date.now(),
    currentTimeMillis: Effect.sync(() => Date.now()),
    monotonicTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
    sleep: (duration) => Effect.sleep(duration),
  };
}

export interface DaemonOptions {
  readonly dbPath: string;
  readonly port?: number;
  /** Issue #16: the tick cadence of the config schedules, over the default. */
  readonly schedulerIntervalMs?: number;
  readonly config?: FactoryConfig;
  readonly clock?: Clock.Clock;
}

export interface DaemonHandle {
  readonly server: ReturnType<typeof serve>;
  readonly schedulerFiber: AnyFiber | undefined;
  readonly services: DaemonServices;
  /**
   * Shut the daemon down: interrupt the scheduler, stop the HTTP server, and
   * dispose the agent runtime (issue #36).
   */
  readonly stop: () => Promise<void>;
}

export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  await mkdir(dirname(options.dbPath), { recursive: true });
  const db = openStore(options.dbPath);

  const runtime = makeAgentRuntime(options.config?.agent.adapter);

  const services: DaemonServices = {
    registry: createRunRegistry(),
    pubsub: createPubSub(),
    dedupeRegistry: createDedupeRegistry(),
    refreshGates: createRefreshGates(),
  };

  const server = serve({
    db,
    runtime,
    services,
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
          const deps: SchedulerDeps = {
            schedules: toRuntimeSchedules(config),
            fire: makeScheduleFire({
              db,
              runtime,
              services,
              maxConcurrentRuns,
              workspace,
              repo,
              dispatchEnv,
            }),
            dedupeRegistry: services.dedupeRegistry,
            clock: options.clock ?? createLiveClock(),
          };
          const state = createSchedulerState(deps);
          return Effect.runFork(
            runSchedulerLoop(
              deps,
              state,
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

  return { server, schedulerFiber, services, stop };
}
