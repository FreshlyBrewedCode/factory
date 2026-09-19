/**
 * The seam between `runAgentStep` (runtime/agent-step.ts) and whatever
 * actually produces a chunk stream. Live opencode for real runs, corpus
 * replay for `bun test` (STATUS.md phase 1: "make the fake adapter a corpus
 * replayer") — same runtime code path either way, only this function swaps.
 *
 * ADR 0012 §2: the adapter interprets its own chunk stream and yields the
 * opaque chunk together with a normalized signal drawn from a small closed
 * union. The runtime consumes signals directly; it never string-matches a
 * vendor event name. A member exists in the union only when Factory has a
 * field for it (`AgentStepFinished.sessionId`, `.output`, `.error`).
 */

export interface AgentAdapterOptions {
  readonly threadId: string;
  readonly dir: string;
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
 */
export type AgentSignal =
  | { readonly _tag: "sessionId"; readonly value: string }
  | { readonly _tag: "structuredOutput"; readonly value: unknown }
  | { readonly _tag: "runError"; readonly value: string };

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

export interface AgentAdapter {
  stream(options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield>;
  /**
   * ADR 0012 §3: the adapter prepares its own workspace before the first
   * agent step. The opencode adapter writes `opencode.json` with a
   * never-ask permission policy (#24) and excludes it from staging. Other
   * adapters may no-op (replay, scratch).
   */
  prepareWorkspace(dir: string): Promise<void>;
}
