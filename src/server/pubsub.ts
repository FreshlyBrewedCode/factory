/**
 * In-process fan-out of live `RunEvent`s, keyed by `runId`. Exists only so
 * `/api/runs/:id/events` (`src/server/http.ts`) can tail a run that is still
 * in flight — persisted history always comes from `getRunEvents`
 * (`src/persistence/store.ts`); this is the gap between "last flushed to
 * sqlite" and "just happened", not a second source of truth.
 *
 * Each daemon creates its own PubSub via `createPubSub()` so two daemons in
 * one process do not share subscriber state (#38).
 */

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
