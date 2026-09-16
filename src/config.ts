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
/** Issue #14: how deep a parent → child → grandchild chain may nest. */
export const DEFAULT_MAX_DISPATCH_DEPTH = 5;
/** Issue #14: how many children one run itself may dispatch. */
export const DEFAULT_MAX_CHILDREN_PER_RUN = 20;

/**
 * Where `factory init` writes the project, and where every command looks when
 * no `--config` is given. `.factory/` holds both the authored source (this
 * config, `workflows/`) and the regenerable state (`factory.db`,
 * `workspaces/`) — `factory init` writes the `.gitignore` lines that keep the
 * two apart.
 *
 * The bare `factory.config.ts` fallback is the pre-`init` layout: phase 5's
 * sample and every config written before `init` existed live at the project
 * root, and they keep working untouched.
 */
export const DEFAULT_CONFIG_PATHS = [".factory/factory.config.ts", "factory.config.ts"] as const;

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
  /**
   * Issue #14: nested-run caps, over the defaults (`DEFAULT_MAX_DISPATCH_DEPTH`,
   * `DEFAULT_MAX_CHILDREN_PER_RUN`). A workflow that dispatches itself must
   * not be able to fill the daemon.
   */
  readonly maxDispatchDepth: number;
  readonly maxChildrenPerRun: number;
}

export interface FactoryConfigInput {
  readonly repo: RepoConfig;
  readonly workflows: ReadonlyArray<WorkflowDefinition<any, any>>;
  readonly workspaceRoot?: string;
  readonly maxConcurrentRuns?: number;
  readonly retainedWorkspaces?: number;
  readonly maxDispatchDepth?: number;
  readonly maxChildrenPerRun?: number;
}

export function defineConfig(config: FactoryConfigInput): FactoryConfig {
  const maxConcurrentRuns = config.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const retainedWorkspaces = config.retainedWorkspaces ?? DEFAULT_RETAINED_WORKSPACES;
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error(
      `maxConcurrentRuns must be an integer >= 1 (got ${JSON.stringify(config.maxConcurrentRuns)})`,
    );
  }
  if (!Number.isInteger(retainedWorkspaces) || retainedWorkspaces < maxConcurrentRuns) {
    throw new Error(
      `retainedWorkspaces (${retainedWorkspaces}) must be >= maxConcurrentRuns (${maxConcurrentRuns}) — retention below the concurrency limit can evict a running run's workspace`,
    );
  }
  const maxDispatchDepth = config.maxDispatchDepth ?? DEFAULT_MAX_DISPATCH_DEPTH;
  const maxChildrenPerRun = config.maxChildrenPerRun ?? DEFAULT_MAX_CHILDREN_PER_RUN;
  if (!Number.isInteger(maxDispatchDepth) || maxDispatchDepth < 1) {
    throw new Error(
      `maxDispatchDepth must be an integer >= 1 (got ${JSON.stringify(config.maxDispatchDepth)})`,
    );
  }
  if (!Number.isInteger(maxChildrenPerRun) || maxChildrenPerRun < 1) {
    throw new Error(
      `maxChildrenPerRun must be an integer >= 1 (got ${JSON.stringify(config.maxChildrenPerRun)})`,
    );
  }
  return {
    repo: config.repo,
    workflows: config.workflows,
    workspaceRoot: config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    maxConcurrentRuns,
    retainedWorkspaces,
    maxDispatchDepth,
    maxChildrenPerRun,
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

/**
 * The config path a command should use when the operator gave no `--config`:
 * the first of `DEFAULT_CONFIG_PATHS` that exists, or `undefined` when this is
 * not a factory project yet. Callers decide what "not a project" means —
 * `serve` runs registry-less, `init` treats it as the go-ahead to scaffold.
 */
export async function findFactoryConfig(cwd: string = process.cwd()): Promise<string | undefined> {
  for (const candidate of DEFAULT_CONFIG_PATHS) {
    const path = `${cwd}/${candidate}`;
    if (await Bun.file(path).exists()) return path;
  }
  return undefined;
}

export async function loadFactoryConfig(path?: string): Promise<FactoryConfig> {
  const requested = path ?? (await findFactoryConfig());
  if (requested === undefined) {
    throw new Error(
      `no factory config found — looked for ${DEFAULT_CONFIG_PATHS.join(" and ")} in ${process.cwd()}. Run \`factory init\` to create one.`,
    );
  }
  const resolved = /^(\.{1,2}\/|\/)/.test(requested) ? requested : `${process.cwd()}/${requested}`;
  const imported: unknown = await import(resolved);
  const config = (imported as { default?: FactoryConfig }).default;
  if (config === undefined || config.repo === undefined || config.workflows === undefined) {
    throw new Error(`${requested} has no default defineConfig(...) export`);
  }
  return config;
}
