/**
 * The agent runtime as an Effect context service (ADR 0012 §4).
 *
 * The runtime is the daemon's first service to move into Effect's dependency
 * injection: it stops being a value threaded through every interface between
 * the CLI and the step runner, and becomes a service resolved from context at
 * the point of use (`runtime/agent-step.ts`).
 *
 * The service shape is deliberately small: it currently exposes only the
 * adapter, which is the part issue #36 needs to make selectable from config.
 */

import { Context, Layer, ManagedRuntime } from "effect";
import type { AgentAdapter } from "./agent-adapter";
import { opencodeAdapter } from "./opencode-adapter";

export interface AgentRuntimeShape {
  /** The adapter that produces agent chunk streams (ADR 0012 §2). */
  readonly adapter: AgentAdapter;
}

/**
 * The agent-runtime service. Yield it inside an Effect to read the adapter;
 * provide it with `AgentRuntimeLayer`.
 */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeShape>()(
  "AgentRuntime",
) {}

/**
 * A layer that provides `adapter`, or the live opencode adapter when none is
 * given. This is the single place the opencode default lives: config leaves
 * `agent.adapter` unset unless a project chooses one.
 */
export const AgentRuntimeLayer = (
  adapter: AgentAdapter = opencodeAdapter,
): Layer.Layer<AgentRuntime> => Layer.succeed(AgentRuntime, { adapter });

/**
 * Build a `ManagedRuntime` providing the agent runtime — the composition root
 * of the daemon and the CLI's direct-run path, and a convenience for tests.
 * The caller owns it and must `dispose()` it once its runs are done.
 */
export const makeAgentRuntime = (
  adapter?: AgentAdapter,
): ManagedRuntime.ManagedRuntime<AgentRuntime, never> =>
  ManagedRuntime.make(AgentRuntimeLayer(adapter));
