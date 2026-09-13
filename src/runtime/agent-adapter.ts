/**
 * The seam between `runAgentStep` (runtime/agent-step.ts) and whatever
 * actually produces a chunk stream. Live opencode for real runs, corpus
 * replay for `bun test` (STATUS.md phase 1: "make the fake adapter a corpus
 * replayer") — same runtime code path either way, only this function swaps.
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

export interface AgentAdapter {
  stream(options: AgentAdapterOptions): AsyncIterable<unknown>;
}
