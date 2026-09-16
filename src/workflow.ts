/**
 * The workflow authoring surface (ADR 0002, D19). Plain imperative `async`
 * control flow over a six-member `ctx` — no framework surface, no step
 * graph. This is the shape phase 0's spike proved by hand
 * (`src/spike/workflow.ts`'s `WorkflowContext` + `fullRoundTrip`); this file
 * is where it hardens.
 *
 * `factory` (this module) re-exports `Schema` so workflow files never import
 * `effect` directly (ADR 0002 §1) — it relocates the coupling, it does not
 * remove it.
 */

import { Schema } from "effect";
import type { ExecResult } from "./lib/exec";
import type { WriteBackResult } from "./lib/writeback";

export { Schema };

/**
 * Per-call agent options. Precedence for `model`/`permissionMode`:
 * per-call option > workflow's `agent` default > runtime fallback.
 */
export interface AgentCallOptions {
  readonly model?: string;
  readonly permissionMode?: "acceptEdits" | "default";
  /** An Effect Schema. Converted to JSON Schema only at the adapter boundary. */
  readonly output?: Schema.Codec<any, any>;
}

/**
 * The full granular result of one `ctx.agent` call (ADR 0002 §2: "not a
 * distilled type" — the spike's tier-2 manual re-parse needs `finalText`,
 * and hiding it costs flexibility for zero savings).
 */
export interface AgentResult<O = unknown> {
  readonly stepId: string;
  readonly chunkCount: number;
  readonly finalText: string;
  /** Present only when tier 1 or tier 2 extraction produced a value matching `opts.output`. */
  readonly output: O | undefined;
  readonly sessionId: string | undefined;
  readonly error: string | undefined;
}

export type AssertCallback = () =>
  | boolean
  | { pass: boolean; details?: unknown }
  | Promise<boolean | { pass: boolean; details?: unknown }>;

export interface AssertResult {
  readonly name: string;
  readonly pass: boolean;
  readonly details: unknown;
}

export interface WriteBackCallOptions {
  readonly branch: string;
  readonly commitMessage: string;
  readonly prTitle: string;
  readonly prBody: string;
}

/**
 * The six-member run context (ADR 0002 §2/§4). Ownership rule: the runtime
 * owns the tree, the log, and cancellation; the workflow owns everything
 * else.
 */
export interface WorkflowCtx {
  /** The prepared working tree. The runtime clones; the workflow never does (D8). */
  readonly dir: string;
  agent<O = unknown>(
    name: string,
    prompt: string,
    opts?: AgentCallOptions,
  ): Promise<AgentResult<O>>;
  /** Never throws (D9) — non-zero exit is the workflow's branching primitive. */
  exec(argv: ReadonlyArray<string>): Promise<ExecResult>;
  /** Records and returns; never throws. Throw yourself in the workflow if you mean it. */
  assert(name: string, callback: AssertCallback): Promise<AssertResult>;
  log(name: string, data: unknown): Promise<void>;
  /**
   * Border case (ADR 0002 §2, demotion trigger: the first second workflow).
   * Host `git`/`gh`, not an agent instruction (D9).
   */
  writeBack(options: WriteBackCallOptions): Promise<WriteBackResult>;
}

export interface WorkflowAgentDefaults {
  readonly model?: string;
  readonly permissionMode?: "acceptEdits" | "default";
}

/**
 * How the run's working directory is provisioned (issue #13):
 * - `clone` (the default) is D28's per-run tree: mirror refresh + local clone.
 * - `scratch` is an empty directory: no mirror, no clone. `ctx.exec` and
 *   `ctx.agent` work unchanged — an agent needs a working directory, not a
 *   repo — and `ctx.writeBack` fails: there is nothing to push.
 *
 * A tagged union, not an optional `dir`: "no workspace" is deliberately not
 * representable, because a nullable `ctx.dir` would force null branches
 * through exec, the agent adapter, and write-back for no benefit.
 */
export type WorkspaceKind = "clone" | "scratch";

export interface WorkspaceSpec {
  readonly kind: WorkspaceKind;
}

export interface WorkflowConfig<I, O> {
  readonly input: Schema.Codec<I, any>;
  readonly output?: Schema.Codec<O, any>;
  readonly agent?: WorkflowAgentDefaults;
  /** Absent, the workflow runs on a `clone` workspace. */
  readonly workspace?: WorkspaceSpec;
  readonly run: (ctx: WorkflowCtx, input: I) => Promise<O>;
}

export interface WorkflowDefinition<I = unknown, O = unknown> {
  readonly id: string;
  readonly input: Schema.Codec<I, any>;
  readonly output: Schema.Codec<O, any> | undefined;
  readonly agent: WorkflowAgentDefaults | undefined;
  /** Resolved to `{kind:"clone"}` at registration — clone is the default (issue #13). */
  readonly workspace: WorkspaceSpec;
  readonly run: (ctx: WorkflowCtx, input: I) => Promise<O>;
}

/** Registration surface (D5): a module exports one of these as `default`. */
export function defineWorkflow<I, O>(
  id: string,
  config: WorkflowConfig<I, O>,
): WorkflowDefinition<I, O> {
  return {
    id,
    input: config.input,
    output: config.output,
    agent: config.agent,
    workspace: config.workspace ?? { kind: "clone" },
    run: config.run,
  };
}
