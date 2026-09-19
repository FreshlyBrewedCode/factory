/**
 * The seam between `runAgentStep` (runtime/agent-step.ts) and whatever
 * actually produces a chunk stream. Live opencode for real runs, corpus
 * replay for `bun test` (STATUS.md phase 1: "make the fake adapter a corpus
 * replayer") — same runtime code path either way, only this function swaps.
 *
 * ADR 0012 §2: the adapter interprets its own stream. Each yielded item is
 * the opaque AG-UI chunk **plus** an optional normalized signal drawn from
 * the closed union below. The runtime records signals and never matches a
 * vendor event name.
 */

/**
 * The normalized signal union Factory owns — deliberately tiny (ADR 0012 §2):
 * a member exists only when the runtime has a durable field for it, not as a
 * general capability model for agents.
 *
 * - `session`          → populates `AgentStepFinished.sessionId`
 * - `structured-output` → populates the value `resolveOutput` decodes into
 *                        `AgentStepFinished.output` (tier 1 of the two-tier
 *                        resolution; the `finalText` re-parse stays tier 2)
 * - `error`            → populates `AgentStepFinished.error`
 */
export type AgentSignal =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "structured-output"; readonly value: unknown }
  | { readonly kind: "error"; readonly message: string };

/**
 * One item of an adapter's stream: the AG-UI chunk verbatim (ADR 0003 §2 —
 * the SPA keeps folding these with `StreamProcessor`), plus the signal the
 * adapter interpreted out of it, if any.
 */
export interface AgentStreamItem {
  readonly chunk: unknown;
  readonly signal?: AgentSignal;
}

export interface AgentAdapterOptions {
  readonly threadId: string;
  readonly dir: string;
  readonly model: string;
  readonly prompt: string;
  /** JSON Schema, converted from the workflow's Effect Schema at this boundary. */
  readonly outputSchema?: unknown;
  readonly abortController: AbortController;
}

export interface AgentAdapter {
  stream(options: AgentAdapterOptions): AsyncIterable<AgentStreamItem>;
}
