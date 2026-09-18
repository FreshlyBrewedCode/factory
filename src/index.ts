/**
 * The public entry point of `@frebreco/factory` — everything a project needs
 * to author workflows and a config, and nothing else.
 *
 * A project installs factory as a dev dependency, writes `.factory/` with
 * `factory init`, and imports only from here:
 *
 * ```ts
 * import { defineConfig, defineWorkflow, Schema } from "@frebreco/factory";
 * ```
 *
 * The deep modules behind this barrel (`runtime/`, `server/`, `persistence/`,
 * `web/`) are deliberately *not* re-exported. They are the daemon's internals,
 * reachable by the bundled `factory` CLI; a workflow that needs one of them is
 * a signal that the authoring surface is missing something, not that the
 * barrel is too narrow.
 */

// --- Authoring: workflows (ADR 0002, D19) -----------------------------------

export { defineWorkflow, Schema } from "./workflow";

export type {
  AgentCallOptions,
  AgentResult,
  AssertCallback,
  AssertResult,
  WorkspaceKind,
  WorkspaceSpec,
  WorkflowAgentDefaults,
  WorkflowConfig,
  WorkflowCtx,
  WorkflowDefinition,
  WriteBackCallOptions,
} from "./workflow";

// --- Authoring: the project config (ADR 0005, D27) --------------------------

export {
  DEFAULT_MAX_CHILDREN_PER_RUN,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_DISPATCH_DEPTH,
  DEFAULT_RETAINED_WORKSPACES,
  DEFAULT_WORKSPACE_ROOT,
  defineConfig,
  defineSchedule,
} from "./config";

export type {
  FactoryConfig,
  FactoryConfigInput,
  RepoConfig,
  ScheduleConfig,
  ScheduleConfigInput,
  ScheduleDefinition,
  ScheduleOverlapPolicy,
} from "./config";

// --- Result types a workflow body observes ----------------------------------

/** What `ctx.exec` resolves to. Never throws — a non-zero exit is a branch. */
export type { ExecResult } from "./lib/exec";

/** What `ctx.writeBack` resolves to, including the branch it actually used. */
export type { WriteBackResult } from "./lib/writeback";

/** The git identity a config's `repo` block carries. */
export type { GitIdentity } from "./lib/clone";

/**
 * The dedupe-key collision (issue #15's `DedupeKeyError`), exported so a
 * wrapper workflow can catch `ctx.dispatch` collisions *by type* — per-item
 * catch-and-record in a sweep, rather than message-matching. Its `key` and
 * `holderRunId` members are the observable half (the runtime already emits
 * `DispatchCollision` alongside, regardless of the catch).
 */
export { DedupeKeyError } from "./lib/dedupe";

// --- The run event log (D3, ADR 0003) ---------------------------------------
// Read-only for consumers: the shape `GET /api/runs/:id/events` streams, so a
// script can type a custom client without reaching into `persistence/`.

export type { Outcome, RunEvent, RunEventPayload } from "./events";

/** `isTerminal(event.payload)` — the stop condition for tailing a run's events. */
export { isTerminal } from "./events";
