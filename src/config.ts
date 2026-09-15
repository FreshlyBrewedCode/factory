/**
 * D27's project entry point: `factory.config.ts` at the repo root, imported
 * by `factory serve` (ADR 0005). It carries the run environment (repo,
 * workspace root, concurrency, retention) and the workflow registry — the
 * import list *is* the registry, because the operator's config module is the
 * explicit registration act (D5's scan-without-execution problem disappears
 * with it).
 */

import type { GitIdentity } from "./lib/clone";
import type { WorkflowDefinition } from "./workflow";

export const DEFAULT_WORKSPACE_ROOT = ".factory/workspaces";
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;
export const DEFAULT_RETAINED_WORKSPACES = 10;

export interface RepoConfig {
  readonly sshUrl: string;
  readonly identity: GitIdentity;
  readonly baseBranch: string;
  readonly slug: string;
}

export interface FactoryConfig {
  readonly repo: RepoConfig;
  readonly workflows: ReadonlyArray<WorkflowDefinition<any, any>>;
  readonly workspaceRoot: string;
  readonly maxConcurrentRuns: number;
  readonly retainedWorkspaces: number;
}

export interface FactoryConfigInput {
  readonly repo: RepoConfig;
  readonly workflows: ReadonlyArray<WorkflowDefinition<any, any>>;
  readonly workspaceRoot?: string;
  readonly maxConcurrentRuns?: number;
  readonly retainedWorkspaces?: number;
}

export function defineConfig(config: FactoryConfigInput): FactoryConfig {
  return {
    repo: config.repo,
    workflows: config.workflows,
    workspaceRoot: config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    maxConcurrentRuns: config.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
    retainedWorkspaces: config.retainedWorkspaces ?? DEFAULT_RETAINED_WORKSPACES,
  };
}

/**
 * A projection of `FactoryConfig` for consumers that run workflows but do not
 * serve the registry (e.g. the dispatcher's wiring). The HTTP layer takes the
 * full config directly.
 */
export interface RunEnvironment {
  readonly repo: RepoConfig;
  readonly workspaceRoot: string;
  readonly maxConcurrentRuns: number;
  readonly retainedWorkspaces: number;
}

export function toRunEnvironment(config: FactoryConfig): RunEnvironment {
  return {
    repo: config.repo,
    workspaceRoot: config.workspaceRoot,
    maxConcurrentRuns: config.maxConcurrentRuns,
    retainedWorkspaces: config.retainedWorkspaces,
  };
}

export async function loadFactoryConfig(path = "factory.config.ts"): Promise<FactoryConfig> {
  const resolved = /^(\.{1,2}\/|\/)/.test(path) ? path : `${process.cwd()}/${path}`;
  const imported: unknown = await import(resolved);
  const config = (imported as { default?: FactoryConfig }).default;
  if (config === undefined || config.repo === undefined || config.workflows === undefined) {
    throw new Error(`${path} has no default defineConfig(...) export`);
  }
  return config;
}
