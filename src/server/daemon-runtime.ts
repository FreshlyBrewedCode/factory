/**
 * The daemon's composition root as a value (#38, ADR 0009 §5, following
 * #36's `AgentRuntime`): every per-daemon singleton is a `Context.Service`,
 * and `DaemonLayer` composes their layers with `AgentRuntimeLayer` into one
 * `ManagedRuntime`. Building the runtime builds the state — a fresh run
 * registry, pubsub, dedupe registry and refresh-gate queue — so two daemons
 * are two runtimes, and a test that wants clean state builds a new one.
 *
 * The boundaries (HTTP handlers, the scheduler's fire function, `ctx.dispatch`)
 * stay plain async per ADR 0009 §5 and resolve services from the runtime with
 * `serviceOf`. Every layer here is synchronous, so `serviceOf` is a
 * synchronous lookup — which is what lets `startTrackedRun` resolve its
 * services and still reserve its slot with no `await` between check and set.
 */

import { Effect, Layer, ManagedRuntime, type Context } from "effect";
import { DedupeRegistry, DedupeRegistryLayer } from "../lib/dedupe";
import { RefreshGates, RefreshGatesLayer } from "../lib/workspace";
import { AgentRuntime, AgentRuntimeLayer, type AgentRuntimeConfig } from "../runtime/agent-runtime";
import { RunPubSub, RunPubSubLayer } from "./pubsub";
import { RunRegistry, RunRegistryLayer } from "./runs";

/** Every service a daemon runtime provides. */
export type DaemonServices = AgentRuntime | RunRegistry | RunPubSub | DedupeRegistry | RefreshGates;

/** The daemon's `ManagedRuntime`: the agent runtime plus its per-daemon state. */
export type DaemonRuntime = ManagedRuntime.ManagedRuntime<DaemonServices, never>;

/**
 * The daemon's layer: the agent runtime for `agent` (config's `agent` block —
 * the ACP runtime unless it injects an adapter) plus fresh per-daemon state.
 */
export const DaemonLayer = (agent?: AgentRuntimeConfig): Layer.Layer<DaemonServices> =>
  Layer.mergeAll(
    AgentRuntimeLayer(agent),
    RunRegistryLayer,
    RunPubSubLayer,
    DedupeRegistryLayer,
    RefreshGatesLayer,
  );

/**
 * Build a daemon runtime. The caller owns it and must `dispose()` it; tests
 * build one per case for isolated state.
 */
export const makeDaemonRuntime = (agent?: AgentRuntimeConfig): DaemonRuntime =>
  ManagedRuntime.make(DaemonLayer(agent));

/**
 * Resolve one of the daemon's services from its runtime, synchronously — the
 * plain-async boundary's way into the context. Owners build the layers eagerly
 * (`startDaemon` awaits `runtime.context()`; `createTestDaemon` resolves at
 * construction), so this reads an already-built context.
 */
export function serviceOf<I extends DaemonServices, S>(
  runtime: DaemonRuntime,
  service: Context.Key<I, S>,
): S {
  return runtime.runSync(Effect.service(service));
}
