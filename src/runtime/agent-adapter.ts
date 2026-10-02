/**
 * The seam between `runAgentStep` (runtime/agent-step.ts) and whatever
 * actually produces a chunk stream. The ACP runtime for real runs, corpus
 * replay for `bun test` (STATUS.md phase 1: "make the fake adapter a corpus
 * replayer") — same runtime code path either way, only this function swaps.
 *
 * ADR 0012 §2: the adapter interprets its own chunk stream and yields the
 * opaque chunk together with a normalized signal drawn from a small closed
 * union. The runtime consumes signals directly; it never string-matches a
 * vendor event name. A member exists in the union only when Factory has a
 * field for it (`AgentStepFinished.sessionId`, `.output`, `.error`).
 */

import type { AcpAgentKind } from "./acp-agents";

export interface AgentAdapterOptions {
  readonly threadId: string;
  readonly dir: string;
  /**
   * The agent this step runs on, resolved like `model` (ADR 0013 §2). The
   * runtime's default adapter launches it; an adapter that stands in for
   * every agent (replay, fakes, an injected single-agent adapter) may ignore
   * it.
   */
  readonly agent: AcpAgentKind;
  /** The agent's own model id, always present (ADR 0013 §2). */
  readonly model: string;
  readonly prompt: string;
  /** JSON Schema, converted from the workflow's Effect Schema at this boundary. */
  readonly outputSchema?: unknown;
  readonly abortController: AbortController;
}

/**
 * The normalized signal union (ADR 0012 §2). Each member populates one
 * field on `AgentStepFinished`:
 * - `sessionId` → `AgentStepFinished.sessionId`
 * - `structuredOutput` → `AgentStepFinished.output` (via `resolveOutput`)
 * - `runError` → `AgentStepFinished.error`
 * - `usage` → `AgentStepFinished.context` / `.cost` (ADR 0013 §5; recorded
 *   from #65 on — until then the runtime reads past it)
 */
export type AgentSignal =
  | { readonly _tag: "sessionId"; readonly value: string }
  | { readonly _tag: "structuredOutput"; readonly value: unknown }
  | { readonly _tag: "runError"; readonly value: string }
  | { readonly _tag: "usage"; readonly value: AgentUsage };

/**
 * What an agent reports about its context window and spend (ACP
 * `usage_update`), as the agent measured it. The last one of a step stands.
 */
export interface AgentUsage {
  /** Tokens in context now, and the window size. */
  readonly context: { readonly used: number; readonly size: number };
  /** What the session has cost so far; absent when the agent does not say. */
  readonly cost?: { readonly amount: number; readonly currency: string };
}

/**
 * One item yielded by an adapter: the opaque AG-UI chunk (unchanged) plus
 * an optional signal. The chunk is forwarded verbatim to `AgentChunk` events
 * and to the SPA's `StreamProcessor`. The signal is consumed by the runtime
 * to populate `AgentStepFinished` fields.
 */
export interface AgentAdapterYield {
  readonly chunk: unknown;
  readonly signal?: AgentSignal;
}

/**
 * Adapters own all chunk interpretation, including errors: the runtime no
 * longer detects `RUN_ERROR` chunks itself, so an adapter must emit a
 * `runError` signal for every chunk that reports a run failure, or the step
 * will finish without `AgentStepFinished.error`.
 */
export interface AgentAdapter {
  stream(options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield>;
  /**
   * ADR 0012 §3: the adapter prepares its own workspace before the first
   * agent step. The opencode adapter writes `opencode.json` with a
   * never-ask permission policy (#24) and excludes it from staging. Other
   * adapters may no-op (e.g. the replay and fake adapters).
   */
  prepareWorkspace(dir: string): Promise<void>;
}
