/**
 * D27's project entry point: `factory.config.ts` at the repo root, imported
 * by `factory serve` (ADR 0005). It carries the run environment (repo,
 * workspace root, concurrency, retention) and the workflow registry — the
 * import list *is* the registry, because the operator's config module is the
 * explicit registration act (D5's scan-without-execution problem disappears
 * with it).
 */

import { Cron, Result, SchemaParser } from "effect";
import type { GitIdentity } from "./lib/clone";
import type { WorkflowDefinition } from "./workflow";
import type { AgentAdapter } from "./runtime/agent-adapter";
import { ACP_AGENT_KINDS, type AcpAgentKind, type HostSettings } from "./runtime/acp-agents";
import { DEFAULT_AGENT, isAcpAgentKind, type AgentChoice } from "./runtime/agent-choice";

export const DEFAULT_WORKSPACE_ROOT = ".factory/workspaces";
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;
export const DEFAULT_RETAINED_WORKSPACES = 10;
/** Issue #14: how deep a parent → child → grandchild chain may nest. */
export const DEFAULT_MAX_DISPATCH_DEPTH = 5;
/** Issue #14: how many children one run itself may dispatch. */
export const DEFAULT_MAX_CHILDREN_PER_RUN = 20;

/**
 * The timezone a schedule without one is evaluated in: the system's resolved
 * IANA zone. `Cron.parse` would use the same fallback, but an explicit constant
 * keeps the resolved value visible in the config and the API.
 */
export const DEFAULT_SCHEDULE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

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
  /**
   * Issue #16: cron schedules, validated at load — a schedule is a workflow
   * (by registry id), its input, and a cron expression in an optional
   * timezone (default: the system's, `DEFAULT_SCHEDULE_TIMEZONE`).
   * `defineConfig` validates everything a wrong value would
   * otherwise break at 3am: unregistered workflow, input that fails the
   * workflow's schema, and an unparsable cron expression all throw here,
   * naming the offending schedule.
   */
  readonly schedules: ReadonlyArray<ScheduleConfig>;
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
  /** The agent runtime and the config rung of the agent/model choice, defaults applied. */
  readonly agent: AgentConfig;
}

/**
 * The project's agent settings (ADR 0013 §2, §3), as the operator writes them.
 *
 * ```ts
 * agent: {
 *   default: "claude",
 *   models: { claude: "sonnet", opencode: "opencode/big-pickle" },
 *   hostSettings: { opencode: "include" },
 * }
 * ```
 */
export interface AgentConfigInput {
  /**
   * The agent a step runs on when neither the call, the run, the schedule nor
   * the workflow names one. Default `"opencode"` (`DEFAULT_AGENT`).
   */
  readonly default?: AcpAgentKind;
  /**
   * Each agent's model, used when no level that may name one does (a model
   * never carries across a change of agent). Factory always sends a model and
   * has no built-in one: a step whose model resolves to nothing fails before
   * the agent starts. Ids are the agent's own and passed verbatim.
   */
  readonly models?: Readonly<Partial<Record<AcpAgentKind, string>>>;
  /**
   * Whether runs see the operator's own agent settings (`~/.claude`,
   * `~/.config/opencode`), per agent. Default `"ignore"`: a run reads the
   * project's agent configuration only. Credentials stay available either way.
   */
  readonly hostSettings?: Readonly<Partial<Record<AcpAgentKind, HostSettings>>>;
  /**
   * Issue #36: replaces the ACP runtime with another adapter — the injection
   * point for replay and fakes. An injected adapter still receives the
   * resolved agent and model.
   */
  readonly adapter?: AgentAdapter;
}

/** `AgentConfigInput` with its defaults applied. */
export interface AgentConfig {
  readonly default: AcpAgentKind;
  readonly models: Readonly<Partial<Record<AcpAgentKind, string>>>;
  readonly hostSettings: Readonly<Record<AcpAgentKind, HostSettings>>;
  readonly adapter?: AgentAdapter;
}

const HOST_SETTINGS: ReadonlyArray<HostSettings> = ["ignore", "include"];

function describeAgentKinds(): string {
  return ACP_AGENT_KINDS.map((kind) => JSON.stringify(kind)).join(" | ");
}

function checkAgentChoice(where: string, choice: AgentChoice | undefined): void {
  if (choice === undefined) return;
  if (choice.agent !== undefined && !isAcpAgentKind(choice.agent)) {
    throw new Error(
      `${where} has an unknown agent ${JSON.stringify(choice.agent)} (expected ${describeAgentKinds()})`,
    );
  }
  if (choice.model !== undefined && (typeof choice.model !== "string" || choice.model === "")) {
    throw new Error(
      `${where} has an invalid model ${JSON.stringify(choice.model)} (expected a non-empty string)`,
    );
  }
}

/** Validate `agent` and apply its defaults. Throws naming the offending field. */
export function resolveAgentConfig(input: AgentConfigInput = {}): AgentConfig {
  const fallback = input.default ?? DEFAULT_AGENT;
  if (!isAcpAgentKind(fallback)) {
    throw new Error(
      `agent.default must be one of ${describeAgentKinds()} (got ${JSON.stringify(input.default)})`,
    );
  }
  const models: Partial<Record<AcpAgentKind, string>> = {};
  for (const [key, model] of Object.entries(input.models ?? {})) {
    if (!isAcpAgentKind(key)) {
      throw new Error(
        `agent.models has an unknown agent "${key}" (expected ${describeAgentKinds()})`,
      );
    }
    if (model === undefined) continue;
    if (typeof model !== "string" || model === "") {
      throw new Error(
        `agent.models.${key} must be a non-empty model id (got ${JSON.stringify(model)})`,
      );
    }
    models[key] = model;
  }
  const hostSettings: Record<AcpAgentKind, HostSettings> = { claude: "ignore", opencode: "ignore" };
  for (const [key, value] of Object.entries(input.hostSettings ?? {})) {
    if (!isAcpAgentKind(key)) {
      throw new Error(
        `agent.hostSettings has an unknown agent "${key}" (expected ${describeAgentKinds()})`,
      );
    }
    if (value === undefined) continue;
    if (!HOST_SETTINGS.includes(value)) {
      throw new Error(
        `agent.hostSettings.${key} must be "ignore" or "include" (got ${JSON.stringify(value)})`,
      );
    }
    hostSettings[key] = value;
  }
  return {
    default: fallback,
    models,
    hostSettings,
    ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
  };
}

/**
 * The agents a config can run on: the default, every agent with a configured
 * model, and every agent a workflow or schedule names. What the daemon checks
 * at start (ADR 0013 Consequences). A per-call choice is not visible here.
 */
export function configuredAgents(config: FactoryConfig): AcpAgentKind[] {
  const kinds = new Set<AcpAgentKind>([config.agent.default]);
  for (const kind of ACP_AGENT_KINDS) if (config.agent.models[kind] !== undefined) kinds.add(kind);
  for (const workflow of config.workflows)
    if (workflow.agent?.agent !== undefined) kinds.add(workflow.agent.agent);
  for (const schedule of config.schedules)
    if (schedule.agent?.agent !== undefined) kinds.add(schedule.agent.agent);
  return ACP_AGENT_KINDS.filter((kind) => kinds.has(kind));
}

/**
 * Overlap policy: `"skip"` (the default) does not stack a second run while
 * the previous one is still going; `"stack"` fires regardless. The skip is
 * implemented with the schedule's own id as a dedupe key (issue #15), so the
 * skipped window is observable the same way any dedupe collision is.
 */
export type ScheduleOverlapPolicy = "skip" | "stack";

/** What the operator writes for one schedule in `factory.config.ts` (issue #16). */
export interface ScheduleConfigInput {
  /** Unique within the config — it keys the run's trigger record and the dedupe key. */
  readonly id: string;
  /** The workflow to run, by registry id (`config.workflows`). */
  readonly workflow: string;
  /** The input to pass the workflow. Validated against its schema at load. */
  readonly input: unknown;
  /**
   * A cron expression, stored and validated as cron (5 or 6 fields — Effect's
   * `Cron.parse`), never an opaque scheduling combinator: a next-fire time
   * stays computable and a bad expression fails at load, not at fire time.
   */
  readonly cron: string;
  /**
   * The IANA timezone the expression is evaluated in. Optional — when omitted
   * the daemon's system zone is used (`DEFAULT_SCHEDULE_TIMEZONE`). An
   * explicitly wrong value still fails at load.
   */
  readonly timezone?: string;
  /** Default `"skip"`. */
  readonly overlap?: ScheduleOverlapPolicy;
  /** Fire once when the daemon starts. Default `false`. */
  readonly runOnStart?: boolean;
  /**
   * The schedule's runs' agent and model: the run level of the choice, below
   * a per-call option and above the workflow's and the config's (ADR 0013 §2).
   */
  readonly agent?: AgentChoice;
}

/**
 * What `defineSchedule` returns: the same shape the operator
 * writes by hand, but with the workflow carried as a `WorkflowDefinition`
 * object instead of an id — so the helper type-checks `input` against that
 * workflow's input schema at the definition site.
 */
export interface ScheduleDefinition<I = unknown> {
  readonly id: string;
  /** The workflow to run, as the object `defineWorkflow` returned. */
  readonly workflow: WorkflowDefinition<I, any>;
  /** The input to pass the workflow. Validated against its schema at load. */
  readonly input: I;
  /** A cron expression (5 or 6 fields — Effect's `Cron.parse`). */
  readonly cron: string;
  readonly timezone?: string;
  readonly overlap?: ScheduleOverlapPolicy;
  readonly runOnStart?: boolean;
  readonly agent?: AgentChoice;
}

/**
 * The typed authoring counterpart to the plain `ScheduleConfigInput` object
 *: pass the workflow object itself and `input` is checked against
 * the workflow's input type at definition site, before the daemon even loads.
 */
export function defineSchedule<I>(
  workflow: WorkflowDefinition<I, any>,
  schedule: Omit<ScheduleDefinition<I>, "workflow">,
): ScheduleDefinition<I> {
  return { workflow, ...schedule };
}

/** A schedule as the rest of the code sees it — defaults applied. */
export interface ScheduleConfig {
  readonly id: string;
  readonly workflowId: string;
  readonly input: unknown;
  readonly cron: string;
  readonly timezone: string;
  readonly overlap: ScheduleOverlapPolicy;
  readonly runOnStart: boolean;
  readonly agent: AgentChoice | undefined;
}

export interface FactoryConfigInput {
  readonly repo: RepoConfig;
  readonly workflows: ReadonlyArray<WorkflowDefinition<any, any>>;
  readonly workspaceRoot?: string;
  readonly maxConcurrentRuns?: number;
  readonly retainedWorkspaces?: number;
  readonly maxDispatchDepth?: number;
  readonly maxChildrenPerRun?: number;
  readonly schedules?: ReadonlyArray<ScheduleConfigInput | ScheduleDefinition<any>>;
  /** The agents and their models (ADR 0013). Optional; see `AgentConfigInput`. */
  readonly agent?: AgentConfigInput;
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
  const agent = resolveAgentConfig(config.agent);
  for (const workflow of config.workflows)
    checkAgentChoice(`workflow "${workflow.id}"'s agent`, workflow.agent);
  const schedules = normalizeSchedules(config.schedules ?? []);
  validateSchedules(schedules, config.workflows);
  return {
    repo: config.repo,
    workflows: config.workflows,
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      workflowId: schedule.workflow,
      input: schedule.input,
      cron: schedule.cron,
      timezone: schedule.timezone ?? DEFAULT_SCHEDULE_TIMEZONE,
      overlap: schedule.overlap ?? "skip",
      runOnStart: schedule.runOnStart ?? false,
      agent: schedule.agent,
    })),
    workspaceRoot: config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    maxConcurrentRuns,
    retainedWorkspaces,
    maxDispatchDepth,
    maxChildrenPerRun,
    agent,
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

/**
 * Issue #16: every failure mode a schedule can have is caught at config load,
 * each naming the offending schedule. A bad expression here would otherwise
 * break at 3am, silently using the daemon's own zone, or fail the workflow's
 * schema at first fire instead of at import time.
 *
 * Accepts both authoring forms — the plain object and the `defineSchedule`
 * definition — after normalizing the latter to the plain form, so
 * validation and the rest of the config pipeline stay single-shaped.
 */
export function normalizeSchedules(
  schedules: ReadonlyArray<ScheduleConfigInput | ScheduleDefinition<any>>,
): Array<ScheduleConfigInput> {
  return schedules.map((schedule) => {
    const definition = schedule as ScheduleDefinition<any>;
    if (typeof definition.workflow === "string") {
      return schedule as ScheduleConfigInput;
    }
    return {
      id: definition.id,
      workflow: definition.workflow.id,
      input: definition.input,
      cron: definition.cron,
      timezone: definition.timezone,
      overlap: definition.overlap,
      runOnStart: definition.runOnStart,
      agent: definition.agent,
    };
  });
}

export function validateSchedules(
  schedules: ReadonlyArray<ScheduleConfigInput>,
  workflows: ReadonlyArray<WorkflowDefinition<any, any>>,
): void {
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (typeof schedule.id !== "string" || schedule.id.length === 0) {
      throw new Error(
        `schedule id must be a non-empty string (got ${JSON.stringify(schedule.id)})`,
      );
    }
    if (ids.has(schedule.id)) {
      throw new Error(`duplicate schedule id "${schedule.id}"`);
    }
    ids.add(schedule.id);
    checkAgentChoice(`schedule "${schedule.id}"'s agent`, schedule.agent);

    const workflow =
      workflows.find((w) => w.id === schedule.workflow) ??
      (undefined as WorkflowDefinition<any, any> | undefined);
    if (workflow === undefined) {
      throw new Error(
        `schedule "${schedule.id}" references workflow "${schedule.workflow}", which is not registered in config.workflows`,
      );
    }

    if (typeof schedule.cron !== "string" || schedule.cron.length === 0) {
      throw new Error(
        `schedule "${schedule.id}" has an invalid cron expression ${JSON.stringify(schedule.cron)}`,
      );
    }
    const resolvedTimezone = schedule.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
    const parsed = Cron.parse(schedule.cron, resolvedTimezone);
    if (Result.isFailure(parsed)) {
      const reason = parsed.failure.message ?? String(schedule.cron);
      throw new Error(
        `schedule "${schedule.id}" has an invalid cron expression "${schedule.cron}" in timezone "${resolvedTimezone}": ${reason}`,
      );
    }

    try {
      SchemaParser.decodeUnknownSync(workflow.input)(schedule.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `schedule "${schedule.id}" has an input that fails workflow "${schedule.workflow}"'s schema: ${message}`,
      );
    }
  }
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
