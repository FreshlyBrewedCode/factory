/**
 * Issue #15: the generic replacement for the retired dispatcher's project-board
 * claim lock. A run can start with a dedupe key; while a non-terminal run
 * holds it, starting another run with the same key is a rejection naming both
 * the key and the holding run.
 *
 * The holder registry is deliberately per-process state (same model as
 * server/runs.ts' `active` registry, D24): a run whose process died is
 * "interrupted" (D12), and a fresh daemon process cannot know about a dead
 * process's claims — so a crashed run releases its key by construction rather
 * than holding it forever.
 */

import { describe, expect, test } from "bun:test";
import { createDedupeRegistry, DedupeKeyError } from "./dedupe";

describe("the holder registry (issue #15)", () => {
  test("an unclaimed key claims silently and reports its holder", () => {
    const registry = createDedupeRegistry();
    registry.claim("issue:41", "run-a");
    expect(registry.holderOf("issue:41")).toBe("run-a");
  });

  test("re-claiming by the same run is idempotent", () => {
    const registry = createDedupeRegistry();
    registry.claim("issue:41", "run-a");
    registry.claim("issue:41", "run-a");
    expect(registry.holderOf("issue:41")).toBe("run-a");
  });

  test("a claimed key rejects a second claimant with the key and the holder named", () => {
    const registry = createDedupeRegistry();
    registry.claim("issue:41", "run-a");
    expect(() => registry.claim("issue:41", "run-b")).toThrow(DedupeKeyError);
    const err = (() => {
      try {
        registry.claim("issue:41", "run-b");
      } catch (caught) {
        return caught as DedupeKeyError;
      }
      throw new Error("unreachable");
    })();
    expect(err.key).toBe("issue:41");
    expect(err.holderRunId).toBe("run-a");
    expect(err.message).toContain("issue:41");
    expect(err.message).toContain("run-a");
  });

  test("release frees the key when the holder releases it", () => {
    const registry = createDedupeRegistry();
    registry.claim("issue:41", "run-a");
    registry.release("issue:41", "run-a");
    expect(registry.holderOf("issue:41")).toBeUndefined();
    expect(() => registry.claim("issue:41", "run-b")).not.toThrow();
  });

  test("a non-holder release is a no-op; the holder keeps the key", () => {
    const registry = createDedupeRegistry();
    registry.claim("issue:41", "run-a");
    registry.release("issue:41", "run-b");
    expect(registry.holderOf("issue:41")).toBe("run-a");
  });

  test("holder state is per registry — a new process's registry holds nothing (interrupted release)", () => {
    const dead = createDedupeRegistry();
    dead.claim("issue:41", "run-a");

    const fresh = createDedupeRegistry();
    expect(fresh.holderOf("issue:41")).toBeUndefined();
    expect(() => fresh.claim("issue:41", "run-b")).not.toThrow();
  });
});
