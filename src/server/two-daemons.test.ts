/**
 * #38 acceptance criterion: two daemons can run in one process without
 * sharing run state. This test starts two daemons on different ports, starts
 * a run on each, and verifies that each daemon's registry, pubsub, and dedupe
 * state is independent. Runs are held open on a gate so the cross-daemon
 * checks happen while both are still live.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defineWorkflow } from "../workflow";
import { defineConfig } from "../config";
import { createSlowFakeAdapter, fakeAgents } from "../replay/adapter";
import { startDaemon } from "./daemon";
import { isTerminal, type RunEvent } from "../events";
import type { DaemonHandle } from "./daemon";
import { serviceOf } from "./daemon-runtime";
import { RunRegistry } from "./runs";
import { RunPubSub } from "./pubsub";
import { DedupeRegistry } from "../lib/dedupe";
import { RefreshGates } from "../lib/workspace";

/** Each daemon's own services, resolved from its own runtime's context. */
const registryOf = (daemon: DaemonHandle) => serviceOf(daemon.runtime, RunRegistry);
const pubsubOf = (daemon: DaemonHandle) => serviceOf(daemon.runtime, RunPubSub);
const dedupeOf = (daemon: DaemonHandle) => serviceOf(daemon.runtime, DedupeRegistry);

let releaseRuns: () => void = () => undefined;
let runsGate = Promise.resolve();

function closeGate(): void {
  runsGate = new Promise<void>((resolve) => {
    releaseRuns = resolve;
  });
}

const scratchWorkflow = defineWorkflow("two-daemon-test", {
  input: Schema.Struct({ marker: Schema.String }),
  workspace: { kind: "scratch" },
  run: async (ctx, input) => {
    await runsGate;
    await ctx.exec(["sh", "-c", "sleep 0.1"]);
    return { marker: input.marker };
  },
});

async function waitForTerminal(port: number, runId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`http://localhost:${port}/api/runs/${runId}`);
    const run = (await res.json()) as { status: string };
    if (["RunFinished", "RunFailed", "RunCancelled"].includes(run.status)) return;
    await Bun.sleep(25);
  }
  throw new Error(`run ${runId} did not reach terminal state within ${timeoutMs}ms`);
}

/**
 * Subscribes `runId` on both daemons' pubsubs: the owner's events land in
 * `own`, anything the other daemon publishes for it lands in `foreign`.
 */
function watch(
  owner: DaemonHandle,
  other: DaemonHandle,
  runId: string,
): { readonly own: Array<RunEvent>; readonly foreign: Array<RunEvent>; readonly stop: () => void } {
  const own: Array<RunEvent> = [];
  const foreign: Array<RunEvent> = [];
  const unsubOwn = pubsubOf(owner).subscribe(runId, (event) => own.push(event));
  const unsubOther = pubsubOf(other).subscribe(runId, (event) => foreign.push(event));
  return {
    own,
    foreign,
    stop: () => {
      unsubOwn();
      unsubOther();
    },
  };
}

describe("two daemons in one process (#38)", () => {
  test("two daemons have independent run registries, pubsub, and dedupe state", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-two-daemons-"));

    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      10,
    );

    const daemon1 = await startDaemon({
      dbPath: join(root, "daemon1.db"),
      port: 0,
      config: defineConfig({
        agent: fakeAgents(adapter),
        repo: {
          sshUrl: join(root, "seed-not-used"),
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [scratchWorkflow],
        workspaceRoot: join(root, "workspaces1"),
        retainedWorkspaces: 10,
      }),
    });

    const daemon2 = await startDaemon({
      dbPath: join(root, "daemon2.db"),
      port: 0,
      config: defineConfig({
        agent: fakeAgents(adapter),
        repo: {
          sshUrl: join(root, "seed-not-used"),
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [scratchWorkflow],
        workspaceRoot: join(root, "workspaces2"),
        retainedWorkspaces: 10,
      }),
    });

    try {
      // Two runtimes, two builds of every per-daemon layer: no service
      // instance is shared.
      expect(registryOf(daemon1)).not.toBe(registryOf(daemon2));
      expect(pubsubOf(daemon1)).not.toBe(pubsubOf(daemon2));
      expect(dedupeOf(daemon1)).not.toBe(dedupeOf(daemon2));
      expect(serviceOf(daemon1.runtime, RefreshGates)).not.toBe(
        serviceOf(daemon2.runtime, RefreshGates),
      );

      closeGate();
      const port1 = daemon1.server.port;
      const port2 = daemon2.server.port;
      if (port1 === undefined || port2 === undefined) {
        throw new Error("daemons did not bind to ports");
      }

      const res1 = await fetch(`http://localhost:${port1}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "two-daemon-test", input: { marker: "daemon1" } }),
      });
      expect(res1.status).toBe(201);
      const { runId: runId1 } = (await res1.json()) as { runId: string };

      const res2 = await fetch(`http://localhost:${port2}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "two-daemon-test", input: { marker: "daemon2" } }),
      });
      expect(res2.status).toBe(201);
      const { runId: runId2 } = (await res2.json()) as { runId: string };

      expect(runId1).not.toBe(runId2);

      const watch1 = watch(daemon1, daemon2, runId1);
      const watch2 = watch(daemon2, daemon1, runId2);

      expect(registryOf(daemon1).activeRunIds()).toEqual([runId1]);
      expect(registryOf(daemon2).activeRunIds()).toEqual([runId2]);

      const list1 = (await fetch(`http://localhost:${port1}/api/runs`).then((r) =>
        r.json(),
      )) as Array<{ runId: string }>;
      const list2 = (await fetch(`http://localhost:${port2}/api/runs`).then((r) =>
        r.json(),
      )) as Array<{ runId: string }>;

      expect(list1.map((r) => r.runId)).toEqual([runId1]);
      expect(list2.map((r) => r.runId)).toEqual([runId2]);

      const detail1FromDaemon2 = await fetch(`http://localhost:${port2}/api/runs/${runId1}`);
      expect(detail1FromDaemon2.status).toBe(404);

      const detail2FromDaemon1 = await fetch(`http://localhost:${port1}/api/runs/${runId2}`);
      expect(detail2FromDaemon1.status).toBe(404);

      releaseRuns();
      await waitForTerminal(port1, runId1);
      await waitForTerminal(port2, runId2);

      // Each run's live events reached its own daemon's pubsub, never the other's.
      expect(watch1.own.some((event) => isTerminal(event.payload))).toBe(true);
      expect(watch2.own.some((event) => isTerminal(event.payload))).toBe(true);
      expect(watch1.own.every((event) => event.runId === runId1)).toBe(true);
      expect(watch2.own.every((event) => event.runId === runId2)).toBe(true);
      expect(watch1.foreign).toEqual([]);
      expect(watch2.foreign).toEqual([]);
      watch1.stop();
      watch2.stop();

      expect(registryOf(daemon1).activeRunIds()).toEqual([]);
      expect(registryOf(daemon2).activeRunIds()).toEqual([]);

      const dedupeKey = "shared-key";
      closeGate();
      const res3 = await fetch(`http://localhost:${port1}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "two-daemon-test", input: { marker: "d1" }, dedupeKey }),
      });
      expect(res3.status).toBe(201);
      const { runId: runId3 } = (await res3.json()) as { runId: string };

      // Daemon 1 still holds the key (run 3 is gated) when daemon 2 is asked
      // for the same key — and daemon 2 knows nothing of it.
      expect(dedupeOf(daemon1).holderOf(dedupeKey)).toBe(runId3);
      expect(dedupeOf(daemon2).holderOf(dedupeKey)).toBeUndefined();

      const res4 = await fetch(`http://localhost:${port2}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "two-daemon-test", input: { marker: "d2" }, dedupeKey }),
      });
      expect(res4.status).toBe(201);
      const { runId: runId4 } = (await res4.json()) as { runId: string };

      expect(runId3).not.toBe(runId4);
      expect(dedupeOf(daemon1).holderOf(dedupeKey)).toBe(runId3);
      expect(dedupeOf(daemon2).holderOf(dedupeKey)).toBe(runId4);

      releaseRuns();
      await waitForTerminal(port1, runId3);
      await waitForTerminal(port2, runId4);
    } finally {
      releaseRuns();
      await daemon1.stop();
      await daemon2.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
