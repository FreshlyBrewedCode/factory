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
 * Issue #37 will add workspace preparation behind the same service.
 */

import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { AgentAdapter } from "./agent-adapter";
import { opencodeAdapter } from "./opencode-adapter";

export interface AgentRuntimeShape {
  /** The adapter that produces agent chunk streams (ADR 0012 §2). */
  readonly adapter: AgentAdapter;
}

/**
 * The agent-runtime service. Yield it inside an Effect to read the adapter.
 * The default implementation uses the live opencode adapter; tests and the
 * daemon override it with `AgentRuntimeLayer`.
 */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeShape>()(
  "AgentRuntime",
  { make: Effect.succeed({ adapter: opencodeAdapter }) },
) {}

/**
 * A layer that provides a fixed adapter. Tests use this to swap in the
 * corpus-replay runtime without threading an option through the call chain.
 */
export const AgentRuntimeLayer = (adapter: AgentAdapter): Layer.Layer<AgentRuntime> =>
  Layer.succeed(AgentRuntime, { adapter });

/**
 * Build a `ManagedRuntime` from an adapter. Convenient for tests and for the
 * CLI's direct-run path, which both need to run effects that require
 * `AgentRuntime`.
 */
export const makeAgentRuntime = (
  adapter: AgentAdapter,
): ManagedRuntime.ManagedRuntime<AgentRuntime, never> =>
  ManagedRuntime.make(AgentRuntimeLayer(adapter));
