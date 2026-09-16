/**
 * `factory serve` — wires the HTTP API/SSE (`server/http.ts`) and the
 * optional dispatcher (`server/dispatch.ts`) into one running process
 * (AGENTS.md's third column: "server/daemon that handles lifecycle and
 * automatic dispatch"). Dispatch is opt-in: without `--dispatch-*` flags
 * the daemon just serves the API/SSE over whatever runs already exist.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, type Fiber } from "effect";
type AnyFiber = Fiber.Fiber<unknown, unknown>;
import type { FactoryConfig } from "../config";
import { resetClone, type GitIdentity } from "../lib/clone";
import { hostExec } from "../lib/exec";
import { loadWorkflow } from "../lib/load-workflow";
import { openStore } from "../persistence/store";
import type { AgentAdapter } from "../runtime/agent-adapter";
import { opencodeAdapter } from "../runtime/opencode-adapter";
import { DEFAULT_DISPATCH_CONFIG, runDispatchLoop, type DispatchConfig } from "./dispatch";
import { serve } from "./http";
import {
  makeGitHubProjectsSource,
  type GitHubProjectsConfig,
  type ReadyItem,
} from "./ready-source";
import { activeRunIds, startTrackedRun } from "./runs";

export interface DispatchWiring {
  readonly github: GitHubProjectsConfig;
  readonly repoSlug: string;
  readonly baseBranch: string;
  readonly workflowPath: string;
  readonly workDirRoot: string;
  readonly cloneSshUrl: string;
  readonly gitIdentity: GitIdentity;
  readonly intervalMs: number;
  readonly backoffBaseMinutes?: number;
  readonly backoffCapMinutes?: number;
}

export interface DaemonOptions {
  readonly dbPath: string;
  readonly port?: number;
  readonly adapter?: AgentAdapter;
  readonly dispatch?: DispatchWiring;
  /**
   * The run environment from `factory.config.ts` (D27). Present, every run —
   * manual and dispatched alike — gets a per-run working tree under the
   * configured `workspaceRoot` (D28) and shares one admission limit (D29).
   * Absent, the legacy per-request `{dir, clone}` behaviour is kept.
   */
  readonly config?: FactoryConfig;
}

export interface DaemonHandle {
  readonly server: ReturnType<typeof serve>;
  readonly dispatchFiber: AnyFiber | undefined;
}

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

  let dispatchFiber: AnyFiber | undefined;
  if (options.dispatch !== undefined) {
    const wiring = options.dispatch;
    const source = makeGitHubProjectsSource(wiring.github, hostExec);
    const maxConcurrentRuns = options.config?.maxConcurrentRuns ?? 1;

    const config: DispatchConfig = {
      repoSlug: wiring.repoSlug,
      baseBranch: wiring.baseBranch,
      backoffBaseMinutes: wiring.backoffBaseMinutes ?? DEFAULT_DISPATCH_CONFIG.backoffBaseMinutes,
      backoffCapMinutes: wiring.backoffCapMinutes ?? DEFAULT_DISPATCH_CONFIG.backoffCapMinutes,
    };

    const dispatchItem = async (item: ReadyItem): Promise<string> => {
      const workflow = await loadWorkflow(wiring.workflowPath);
      if (options.config !== undefined) {
        const config = options.config;
        return startTrackedRun(db, workflow, {
          input: { issueNumber: item.issueNumber },
          repo: {
            slug: config.repo.slug,
            baseBranch: config.repo.baseBranch,
          },
          adapter,
          maxConcurrentRuns,
          workspace: {
            workspaceRoot: config.workspaceRoot,
            sshUrl: config.repo.sshUrl,
            identity: config.repo.identity,
            retainedWorkspaces: config.retainedWorkspaces,
          },
          // Issue #14: dispatched workflows may dispatch too — same env as the
          // HTTP start path, so a wrapper workflow's children are real runs.
          dispatchEnv: {
            workspace: {
              workspaceRoot: config.workspaceRoot,
              sshUrl: config.repo.sshUrl,
              identity: config.repo.identity,
              retainedWorkspaces: config.retainedWorkspaces,
            },
            repo: { slug: config.repo.slug, baseBranch: config.repo.baseBranch },
            maxConcurrentRuns,
            adapter,
            maxDispatchDepth: config.maxDispatchDepth,
            maxChildrenPerRun: config.maxChildrenPerRun,
          },
        });
      }
      const dir = `${wiring.workDirRoot}/issue-${item.issueNumber}`;
      await resetClone(dir, wiring.cloneSshUrl, wiring.gitIdentity);
      // No-config legacy dispatch (the pre-D27 `--dispatch-*` shape): phase 3's
      // input contract supplied the branch and the repo environment in the
      // input, so the dispatcher keeps supplying exactly that. D32 moved the
      // write-back environment into the runtime, but a phase-3-era workflow
      // loaded by path still reads these fields, so they are restored rather
      // than silently dropped. `repo` is additionally passed so a D32-era
      // workflow routed through the legacy wiring still gets a working
      // `ctx.writeBack`.
      return startTrackedRun(db, workflow, {
        dir,
        input: {
          issueNumber: item.issueNumber,
          branch: `factory/issue-${item.issueNumber}`,
          repoSlug: wiring.repoSlug,
          baseBranch: wiring.baseBranch,
        },
        repo: { slug: wiring.repoSlug, baseBranch: wiring.baseBranch },
        adapter,
      });
    };

    dispatchFiber = Effect.runFork(
      runDispatchLoop(
        {
          db,
          source,
          config,
          maxConcurrentRuns,
          activeRunCount: () => activeRunIds().length,
          dispatch: dispatchItem,
        },
        wiring.intervalMs,
      ),
    );
  }

  return { server, dispatchFiber };
}
