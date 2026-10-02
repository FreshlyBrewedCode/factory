/**
 * Test support (#38): a fresh daemon runtime per test, with its per-daemon
 * services already resolved for assertions. A new runtime is new state — the
 * tests' isolation comes from building one each, not from resetting
 * singletons. Resolving the services below builds the runtime's layers
 * eagerly and synchronously, so a layer that cannot build that way fails here,
 * at construction, not inside a test's first `serviceOf`.
 */

import type { DedupeRegistryShape } from "../lib/dedupe";
import { DedupeRegistry } from "../lib/dedupe";
import { RefreshGates, type RefreshGatesShape } from "../lib/workspace";
import { FAKE_AGENT_MODELS } from "../replay/adapter";
import type { AgentAdapter } from "../runtime/agent-adapter";
import { makeDaemonRuntime, serviceOf, type DaemonRuntime } from "./daemon-runtime";
import { RunPubSub, type PubSub } from "./pubsub";
import { RunRegistry, type RunRegistryShape } from "./runs";

export interface TestDaemon {
  readonly runtime: DaemonRuntime;
  readonly registry: RunRegistryShape;
  readonly pubsub: PubSub;
  readonly dedupeRegistry: DedupeRegistryShape;
  readonly refreshGates: RefreshGatesShape;
}

export function createTestDaemon(adapter?: AgentAdapter): TestDaemon {
  const runtime = makeDaemonRuntime({
    ...(adapter !== undefined ? { adapter } : {}),
    // Factory always sends a model (ADR 0013 §2); the fakes ignore it.
    models: FAKE_AGENT_MODELS,
  });
  return {
    runtime,
    registry: serviceOf(runtime, RunRegistry),
    pubsub: serviceOf(runtime, RunPubSub),
    dedupeRegistry: serviceOf(runtime, DedupeRegistry),
    refreshGates: serviceOf(runtime, RefreshGates),
  };
}
