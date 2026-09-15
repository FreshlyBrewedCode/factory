import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendEvent, openStore } from "../persistence/store";
import type { RunEvent, RunEventPayload } from "../events";
import {
  DEFAULT_DISPATCH_CONFIG,
  reconcileOnce,
  type DispatchConfig,
  type ReconcileDeps,
} from "./dispatch";
import { makeFakeReadySource, type ReadyItem } from "./ready-source";

function tmpDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "factory-dispatch-test-"));
  return { db: openStore(join(dir, "factory.db")), dir };
}

function seedRun(
  db: Database,
  runId: string,
  issueNumber: number,
  outcome: "RunFinished" | "RunFailed",
  finishedAt: number,
): void {
  let seq = 0;
  const emit = (payload: RunEventPayload, ts: number): void => {
    appendEvent(db, { runId, seq: seq++, ts, payload } as RunEvent);
  };
  emit(
    { _tag: "RunStarted", workflowId: "implement-issue", dir: "/tmp/x", input: { issueNumber } },
    finishedAt - 1000,
  );
  if (outcome === "RunFinished") {
    emit({ _tag: "RunFinished", durationMs: 1000 }, finishedAt);
  } else {
    emit({ _tag: "RunFailed", message: "boom", durationMs: 1000 }, finishedAt);
  }
}

const CONFIG: DispatchConfig = {
  repoSlug: "acme/widgets",
  baseBranch: "main",
  ...DEFAULT_DISPATCH_CONFIG,
};

const ITEM_1: ReadyItem = {
  issueNumber: 1,
  itemId: "item-1",
  title: "issue one",
  hardBlockedBy: [],
};
const ITEM_2: ReadyItem = {
  issueNumber: 2,
  itemId: "item-2",
  title: "issue two",
  hardBlockedBy: [],
};

describe("reconcileOnce", () => {
  test("dispatches the first eligible item and claims it", async () => {
    const { db, dir } = tmpDb();
    const source = makeFakeReadySource([ITEM_1, ITEM_2]);
    const dispatched: Array<ReadyItem> = [];
    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      maxConcurrentRuns: 1,
      activeRunCount: () => 0,
      dispatch: async (item) => {
        dispatched.push(item);
        return `run-for-${item.issueNumber}`;
      },
    };

    const result = await reconcileOnce(deps);
    expect(result).toEqual({ action: "dispatched", issueNumber: 1, runId: "run-for-1" });
    expect(dispatched).toEqual([ITEM_1]);
    expect(source.claimedItemIds).toEqual(["item-1"]);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("WIP limit of 1: skips dispatch entirely while a run is active", async () => {
    const { db, dir } = tmpDb();
    const source = makeFakeReadySource([ITEM_1]);
    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      maxConcurrentRuns: 1,
      activeRunCount: () => 1,
      dispatch: async () => "should-not-run",
    };

    const result = await reconcileOnce(deps);
    expect(result).toEqual({ action: "skipped-wip-limit" });
    expect(source.claimedItemIds).toEqual([]);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the admission limit is shared: over maxConcurrentRuns the pass is skipped", async () => {
    const { db, dir } = tmpDb();
    const source = makeFakeReadySource([ITEM_1]);
    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      maxConcurrentRuns: 2,
      activeRunCount: () => 2,
      dispatch: async () => "should-not-run",
    };

    const result = await reconcileOnce(deps);
    expect(result).toEqual({ action: "skipped-wip-limit" });
    expect(source.claimedItemIds).toEqual([]);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("hard-blocked items are skipped, falling through to the next eligible one", async () => {
    const { db, dir } = tmpDb();
    const blocked: ReadyItem = { ...ITEM_1, hardBlockedBy: [99] };
    const source = makeFakeReadySource([blocked, ITEM_2]);
    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      maxConcurrentRuns: 1,
      activeRunCount: () => 0,
      dispatch: async (item) => `run-for-${item.issueNumber}`,
    };

    const result = await reconcileOnce(deps);
    expect(result).toEqual({ action: "dispatched", issueNumber: 2, runId: "run-for-2" });

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a claim failure (WIP-limit race on the project board) is reported and stops the pass", async () => {
    const { db, dir } = tmpDb();
    const source = makeFakeReadySource([ITEM_1, ITEM_2]);
    source.claimShouldFailFor.add("item-1");
    const dispatched: Array<ReadyItem> = [];
    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      maxConcurrentRuns: 1,
      activeRunCount: () => 0,
      dispatch: async (item) => {
        dispatched.push(item);
        return `run-for-${item.issueNumber}`;
      },
    };

    const result = await reconcileOnce(deps);
    expect(result).toEqual({ action: "skipped-claim-failed", issueNumber: 1 });
    expect(dispatched).toEqual([]);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed issue stays in backoff until its window elapses, then is retried", async () => {
    const { db, dir } = tmpDb();
    const now = 1_000_000_000_000;
    seedRun(db, "run-old-fail", 1, "RunFailed", now - 5 * 60_000); // 5 minutes ago, base backoff is 15

    const source = makeFakeReadySource([ITEM_1]);
    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      maxConcurrentRuns: 1,
      activeRunCount: () => 0,
      dispatch: async () => "should-not-run",
      now: () => now,
    };

    const stillBackingOff = await reconcileOnce(deps);
    expect(stillBackingOff).toEqual({ action: "no-eligible-items" });
    expect(source.claimedItemIds).toEqual([]);

    const laterDeps: ReconcileDeps = {
      ...deps,
      now: () => now + 16 * 60_000,
      dispatch: async () => "run-retry",
    };
    const afterBackoff = await reconcileOnce(laterDeps);
    expect(afterBackoff).toEqual({ action: "dispatched", issueNumber: 1, runId: "run-retry" });

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("backoff doubles per consecutive failure", async () => {
    const { db, dir } = tmpDb();
    const now = 1_000_000_000_000;
    seedRun(db, "run-fail-1", 1, "RunFailed", now - 40 * 60_000);
    seedRun(db, "run-fail-2", 1, "RunFailed", now - 20 * 60_000); // 2nd consecutive failure -> backoff 15*2=30min

    const source = makeFakeReadySource([ITEM_1]);
    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      maxConcurrentRuns: 1,
      activeRunCount: () => 0,
      dispatch: async () => "should-not-run",
      now: () => now, // only 20 min since last failure, needs 30
    };

    const stillBackingOff = await reconcileOnce(deps);
    expect(stillBackingOff).toEqual({ action: "no-eligible-items" });

    const laterDeps: ReconcileDeps = {
      ...deps,
      now: () => now + 15 * 60_000,
      dispatch: async () => "run-retry-2",
    };
    const afterBackoff = await reconcileOnce(laterDeps);
    expect(afterBackoff).toEqual({ action: "dispatched", issueNumber: 1, runId: "run-retry-2" });

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a successful run resets backoff — no delay before the issue could be dispatched again", async () => {
    const { db, dir } = tmpDb();
    const now = 1_000_000_000_000;
    seedRun(db, "run-ok", 1, "RunFinished", now - 10_000);

    const source = makeFakeReadySource([ITEM_1]);
    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      maxConcurrentRuns: 1,
      activeRunCount: () => 0,
      dispatch: async () => "run-again",
      now: () => now,
    };

    const result = await reconcileOnce(deps);
    expect(result).toEqual({ action: "dispatched", issueNumber: 1, runId: "run-again" });

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
