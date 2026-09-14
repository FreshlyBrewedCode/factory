/**
 * Phase 3 exit criterion, the parts provable without a real GitHub project or
 * a real PR: "the daemon picks up a Ready issue unattended, runs the
 * workflow, ... and the run is watchable over SSE." Wires `runDispatchLoop`
 * directly (not `startDaemon`, which hardcodes the real `GitHubProjectsSource`
 * + `hostExec`) against `makeFakeReadySource` and `serve()`, so the glue
 * between dispatch -> `startTrackedRun` -> the event log -> SSE is exercised
 * end to end. The "opens a PR" leg was already proven live in phase 1
 * (`docs/findings/3-live-e2e-run.md`) via the same `ctx.writeBack` the
 * workflow calls; it needs a live run against the real project to prove for
 * phase 3 specifically, which is a separate, explicitly-gated step.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createSlowFakeAdapter } from "../replay/adapter";
import { openStore } from "../persistence/store";
import { reconcileOnce, type DispatchConfig, type ReconcileDeps } from "./dispatch";
import { serve } from "./http";
import { makeFakeReadySource, type ReadyItem } from "./ready-source";
import { activeRunIds, startTrackedRun } from "./runs";

const ECHO_WORKFLOW = `${import.meta.dir}/../../test/fixtures/echo-workflow.ts`;
const { loadWorkflow } = await import("../lib/load-workflow");

const CONFIG: DispatchConfig = {
  repoSlug: "acme/widgets",
  baseBranch: "main",
  backoffBaseMinutes: 15,
  backoffCapMinutes: 1440,
};

describe("phase 3 exit criterion (fakes): unattended pickup -> run -> SSE watch", () => {
  test("a Ready item is picked up without manual intervention, runs to completion, and is watchable over SSE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-integration-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      1,
    );
    const workflow = await loadWorkflow(ECHO_WORKFLOW);
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    const item: ReadyItem = {
      issueNumber: 1,
      itemId: "item-1",
      title: "fix the thing",
      hardBlockedBy: [],
    };
    const source = makeFakeReadySource([item]);

    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      hasActiveRun: () => activeRunIds().length > 0,
      dispatch: (claimedItem) =>
        Promise.resolve(
          startTrackedRun(db, workflow, {
            dir,
            input: {},
            adapter,
            runId: `issue-${claimedItem.issueNumber}`,
          }),
        ),
    };

    try {
      // No run exists yet — nothing has been started manually.
      expect(activeRunIds()).toEqual([]);

      const result = await reconcileOnce(deps);
      expect(result.action).toBe("dispatched");
      expect(source.claimedItemIds).toEqual(["item-1"]);
      const runId = result.action === "dispatched" ? result.runId : "";

      // Watchable over SSE: replay-then-tail should show the run reach a terminal state.
      const res = await fetch(`${base}/api/runs/${runId}/events`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const tags: Array<string> = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
          if (dataLine !== undefined) {
            const event = JSON.parse(dataLine.slice("data:".length).trimStart()) as {
              payload: { _tag: string };
            };
            tags.push(event.payload._tag);
            if (["RunFinished", "RunFailed", "RunCancelled"].includes(event.payload._tag)) {
              reader.releaseLock();
              break;
            }
          }
          idx = buffer.indexOf("\n\n");
        }
        if (
          tags.at(-1) !== undefined &&
          ["RunFinished", "RunFailed", "RunCancelled"].includes(tags.at(-1) as string)
        )
          break;
      }
      expect(tags).toContain("RunStarted");
      expect(tags).toContain("RunFinished");

      const getRes = await fetch(`${base}/api/runs/${runId}`);
      const run = (await getRes.json()) as { status: string };
      expect(run.status).toBe("RunFinished");

      // A second reconcile pass finds no more Ready items — the claim moved the item off "Ready".
      const second = await reconcileOnce(deps);
      expect(second.action).toBe("no-eligible-items");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WIP limit of 1 holds even through the Effect-scheduled loop: a second Ready item waits for the first run to finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-integration-wip-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      60,
    );
    const workflow = await loadWorkflow(ECHO_WORKFLOW);
    const server = serve({ db, adapter, port: 0 });

    const items: Array<ReadyItem> = [
      { issueNumber: 1, itemId: "item-1", title: "first", hardBlockedBy: [] },
      { issueNumber: 2, itemId: "item-2", title: "second", hardBlockedBy: [] },
    ];
    const source = makeFakeReadySource(items);
    const dispatchedIssueNumbers: Array<number> = [];

    const deps: ReconcileDeps = {
      db,
      source,
      config: CONFIG,
      hasActiveRun: () => activeRunIds().length > 0,
      dispatch: (claimedItem) => {
        dispatchedIssueNumbers.push(claimedItem.issueNumber);
        return Promise.resolve(
          startTrackedRun(db, workflow, {
            dir,
            input: {},
            adapter,
            runId: `issue-${claimedItem.issueNumber}`,
          }),
        );
      },
    };

    try {
      const first = await reconcileOnce(deps);
      expect(first.action).toBe("dispatched");
      expect(activeRunIds().length).toBe(1);

      // Immediately after, the run is still in-flight (60ms/chunk adapter delay) — WIP limit blocks a second dispatch.
      const second = await reconcileOnce(deps);
      expect(second.action).toBe("skipped-wip-limit");
      expect(dispatchedIssueNumbers).toEqual([1]);
      expect(source.claimedItemIds).toEqual(["item-1"]);

      await Effect.runPromise(Effect.sleep("500 millis"));
      expect(activeRunIds().length).toBe(0);

      const third = await reconcileOnce(deps);
      expect(third.action).toBe("dispatched");
      expect(dispatchedIssueNumbers).toEqual([1, 2]);
      expect(source.claimedItemIds).toEqual(["item-1", "item-2"]);

      // Let issue-2's run actually reach a terminal state before tearing down the db out from under it.
      await Effect.runPromise(Effect.sleep("500 millis"));
      expect(activeRunIds().length).toBe(0);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
