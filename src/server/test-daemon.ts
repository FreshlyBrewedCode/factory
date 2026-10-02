/**
 * Test support (#38): a fresh daemon runtime per test, with its per-daemon
 * services already resolved for assertions. A new runtime is new state — the
 * tests' isolation comes from building one each, not from resetting
 * singletons.
 */

import type { DedupeRegistryShape } from "../lib/dedupe";
import { DedupeRegistry } from "../lib/dedupe";
import { RefreshGates, type RefreshGatesShape } from "../lib/workspace";
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
  const runtime = makeDaemonRuntime(adapter);
  return {
    runtime,
    registry: serviceOf(runtime, RunRegistry),
    pubsub: serviceOf(runtime, RunPubSub),
    dedupeRegistry: serviceOf(runtime, DedupeRegistry),
    refreshGates: serviceOf(runtime, RefreshGates),
  };
}
