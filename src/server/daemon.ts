/**
 * `factory serve` — wires the HTTP API/SSE (`server/http.ts`) and the config
 * scheduler (`server/scheduler.ts`) into one running process (AGENTS.md's
 * third column). Automatic dispatch is not daemon logic since epic #19: it
 * is project policy living in scheduled wrapper workflows — e.g. the sample
 * project's Ready sweep — fired by the scheduler loop on their cron.
 *
 * #38: the daemon creates per-instance services (run registry, pubsub,
 * dedupe registry, refresh gates) so two daemons can coexist in one process
 * without sharing state.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Clock, Effect, type Fiber } from "effect";
type AnyFiber = Fiber.Fiber<unknown, unknown>;
import type { FactoryConfig } from "../config";
import { openStore } from "../persistence/store";
import type { AgentAdapter } from "../runtime/agent-adapter";
import { opencodeAdapter } from "../runtime/opencode-adapter";
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
  readonly adapter?: AgentAdapter;
  readonly schedulerIntervalMs?: number;
  readonly config?: FactoryConfig;
  readonly clock?: Clock.Clock;
}

export interface DaemonHandle {
  readonly server: ReturnType<typeof serve>;
  readonly schedulerFiber: AnyFiber | undefined;
  readonly services: DaemonServices;
}

export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  await mkdir(dirname(options.dbPath), { recursive: true });
  const db = openStore(options.dbPath);
  const adapter = options.adapter ?? opencodeAdapter;

  const services: DaemonServices = {
    registry: createRunRegistry(),
    pubsub: createPubSub(),
    dedupeRegistry: createDedupeRegistry(),
    refreshGates: createRefreshGates(),
  };

  const server = serve({
    db,
    adapter,
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
            adapter,
            maxDispatchDepth: config.maxDispatchDepth,
            maxChildrenPerRun: config.maxChildrenPerRun,
          };
          const deps: SchedulerDeps = {
            schedules: toRuntimeSchedules(config),
            fire: makeScheduleFire({
              db,
              services,
              adapter,
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

  return { server, schedulerFiber, services };
}
