/**
 * In-process fan-out of live `RunEvent`s, keyed by `runId`. Exists only so
 * `/api/runs/:id/events` (`src/server/http.ts`) can tail a run that is still
 * in flight — persisted history always comes from `getRunEvents`
 * (`src/persistence/store.ts`); this is the gap between "last flushed to
 * sqlite" and "just happened", not a second source of truth.
 *
 * #38: the subscriber map is per daemon, not per module. It is the
 * `RunPubSub` service below; its layer builds a fresh map each time a daemon
 * runtime is built, so two daemons in one process do not share subscribers.
 */

import { Context, Layer } from "effect";
import type { RunEvent } from "../events";

type Listener = (event: RunEvent) => void;

export interface PubSub {
  publish(runId: string, event: RunEvent): void;
  subscribe(runId: string, listener: Listener): () => void;
}

export function createPubSub(): PubSub {
  const subscribers = new Map<string, Set<Listener>>();
  return {
    publish(runId: string, event: RunEvent): void {
      for (const listener of subscribers.get(runId) ?? []) listener(event);
    },
    subscribe(runId: string, listener: Listener): () => void {
      let set = subscribers.get(runId);
      if (set === undefined) {
        set = new Set();
        subscribers.set(runId, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) subscribers.delete(runId);
      };
    },
  };
}

/**
 * The live run-event fan-out as a daemon service (#38, ADR 0009 §5). Named
 * `RunPubSub` rather than `PubSub` so it never reads as Effect's own module.
 */
export class RunPubSub extends Context.Service<RunPubSub, PubSub>()("RunPubSub") {}

export const RunPubSubLayer: Layer.Layer<RunPubSub> = Layer.sync(RunPubSub, createPubSub);
