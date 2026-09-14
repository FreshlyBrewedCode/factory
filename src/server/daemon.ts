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
import { VIEWER_HTML } from "./viewer";

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
}

export interface DaemonHandle {
  readonly server: ReturnType<typeof serve>;
  readonly dispatchFiber: AnyFiber | undefined;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  await mkdir(dirname(options.dbPath), { recursive: true });
  const db = openStore(options.dbPath);
  const adapter = options.adapter ?? opencodeAdapter;

  const server = serve({ db, adapter, port: options.port, viewerHtml: VIEWER_HTML });

  let dispatchFiber: AnyFiber | undefined;
  if (options.dispatch !== undefined) {
    const wiring = options.dispatch;
    const source = makeGitHubProjectsSource(wiring.github, hostExec);

    const config: DispatchConfig = {
      repoSlug: wiring.repoSlug,
      baseBranch: wiring.baseBranch,
      backoffBaseMinutes: wiring.backoffBaseMinutes ?? DEFAULT_DISPATCH_CONFIG.backoffBaseMinutes,
      backoffCapMinutes: wiring.backoffCapMinutes ?? DEFAULT_DISPATCH_CONFIG.backoffCapMinutes,
    };

    const dispatchItem = async (item: ReadyItem): Promise<string> => {
      const dir = `${wiring.workDirRoot}/issue-${item.issueNumber}`;
      await resetClone(dir, wiring.cloneSshUrl, wiring.gitIdentity);
      const workflow = await loadWorkflow(wiring.workflowPath);
      return startTrackedRun(db, workflow, {
        dir,
        input: {
          issueNumber: item.issueNumber,
          branch: `factory/issue-${item.issueNumber}`,
          repoSlug: wiring.repoSlug,
          baseBranch: wiring.baseBranch,
        },
        adapter,
      });
    };

    dispatchFiber = Effect.runFork(
      runDispatchLoop(
        {
          db,
          source,
          config,
          hasActiveRun: () => activeRunIds().length > 0,
          dispatch: dispatchItem,
        },
        wiring.intervalMs,
      ),
    );
  }

  return { server, dispatchFiber };
}
