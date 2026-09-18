/**
 * `factory serve` — wires the HTTP API/SSE (`server/http.ts`) and the config
 * scheduler (`server/scheduler.ts`) into one running process (AGENTS.md's
 * third column). Automatic dispatch is not daemon logic since epic #19: it
 * is project policy living in scheduled wrapper workflows — e.g. the sample
 * project's Ready sweep — fired by the scheduler loop on their cron.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, type Fiber } from "effect";
type AnyFiber = Fiber.Fiber<unknown, unknown>;
import type { FactoryConfig } from "../config";
import { openStore } from "../persistence/store";
import type { AgentAdapter } from "../runtime/agent-adapter";
import { opencodeAdapter } from "../runtime/opencode-adapter";
import { serve } from "./http";
import { type DispatchEnv, type WorkspaceSpec } from "./runs";
import {
  createSchedulerState,
  makeScheduleFire,
  runSchedulerLoop,
  toRuntimeSchedules,
  type SchedulerDeps,
} from "./scheduler";

export interface DaemonOptions {
  readonly dbPath: string;
  readonly port?: number;
  readonly adapter?: AgentAdapter;
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
}

/** Issue #16: how often the scheduler's due window check runs. */
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  await mkdir(dirname(options.dbPath), { recursive: true });
  const db = openStore(options.dbPath);
  const adapter = options.adapter ?? opencodeAdapter;

  const server = serve({
    db,
    adapter,
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
              adapter,
              maxConcurrentRuns,
              workspace,
              repo,
              dispatchEnv,
            }),
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

  return { server, schedulerFiber };
}
