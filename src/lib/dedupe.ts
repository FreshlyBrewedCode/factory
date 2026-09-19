/**
 * Issue #15: the generic dedupe-key lock, replacing the retired dispatcher's
 * project-board claim (a claim lock welded to one specific source of work).
 * A run starts with a dedupe key; while a non-terminal run holds it, starting
 * another run with the same key fails with a `DedupeKeyError` naming the key
 * and the holding run — collisions throw rather than quietly skipping, so a
 * wrapper that is dropping its dispatches is visible in the UI instead of
 * indistinguishable from one that isn't running.
 *
 * State model matches server/runs.ts' active-run registry (D24): per-process,
 * deliberately not sqlite-derived. Claim and release are synchronous
 * in-memory operations, so a start path can check-then-claim with no `await`
 * between and cannot lose the race. The consequence for interruption is the
 * intended one: a run whose process died is "interrupted" (D12), the registry
 * dies with it, and a fresh daemon's empty registry lets the key be claimed
 * again — a dead run must not hold a key forever. Release happens the moment
 * the holding run reaches any terminal state (including cancelled/failed);
 * see `startTrackedRun` in server/runs.ts.
 */

export class DedupeKeyError extends Error {
  readonly key: string;
  readonly holderRunId: string;

  constructor(key: string, holderRunId: string) {
    super(`dedupe key held: "${key}" is currently held by run ${holderRunId}`);
    this.name = "DedupeKeyError";
    this.key = key;
    this.holderRunId = holderRunId;
  }
}

export interface DedupeRegistry {
  /** The run id currently holding `key`, or `undefined`. */
  holderOf(key: string): string | undefined;
  /**
   * Claims `key` for `runId`; throws `DedupeKeyError` when another run holds
   * it. Re-claiming by the holder itself is idempotent (a run re-asserting at
   * the same instant it already holds).
   */
  claim(key: string, runId: string): void;
  /** Releases `key` — only the actual holder's release has an effect. */
  release(key: string, runId: string): void;
}

export function createDedupeRegistry(): DedupeRegistry {
  const held = new Map<string, string>();
  return {
    holderOf: (key) => held.get(key),
    claim(key, runId) {
      const holder = held.get(key);
      if (holder !== undefined && holder !== runId) throw new DedupeKeyError(key, holder);
      held.set(key, runId);
    },
    release(key, runId) {
      if (held.get(key) === runId) held.delete(key);
    },
  };
}


