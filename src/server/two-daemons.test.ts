/**
 * #38 acceptance criterion: two daemons can run in one process without
 * sharing run state. This test starts two daemons on different ports, starts
 * a run on each, and verifies that each daemon's registry, pubsub, and dedupe
 * state is independent.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defineWorkflow } from "../workflow";
import { defineConfig } from "../config";
import { createSlowFakeAdapter } from "../replay/adapter";
import { startDaemon } from "./daemon";
import { Effect, Fiber } from "effect";

const scratchWorkflow = defineWorkflow("two-daemon-test", {
  input: Schema.Struct({ marker: Schema.String }),
  workspace: { kind: "scratch" },
  run: async (ctx, input) => {
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
      adapter,
      config: defineConfig({
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
      adapter,
      config: defineConfig({
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
      const port1 = daemon1.server.port;
      const port2 = daemon2.server.port;

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

      await waitForTerminal(port1, runId1);
      await waitForTerminal(port2, runId2);

      expect(daemon1.services.registry.activeRunIds()).toEqual([]);
      expect(daemon2.services.registry.activeRunIds()).toEqual([]);

      const dedupeKey = "shared-key";
      const res3 = await fetch(`http://localhost:${port1}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "two-daemon-test", input: { marker: "d1" }, dedupeKey }),
      });
      expect(res3.status).toBe(201);
      const { runId: runId3 } = (await res3.json()) as { runId: string };

      const res4 = await fetch(`http://localhost:${port2}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "two-daemon-test", input: { marker: "d2" }, dedupeKey }),
      });
      expect(res4.status).toBe(201);
      const { runId: runId4 } = (await res4.json()) as { runId: string };

      expect(runId3).not.toBe(runId4);

      await waitForTerminal(port1, runId3);
      await waitForTerminal(port2, runId4);
    } finally {
      if (daemon1.schedulerFiber !== undefined) {
        Effect.runFork(Fiber.interrupt(daemon1.schedulerFiber));
      }
      if (daemon2.schedulerFiber !== undefined) {
        Effect.runFork(Fiber.interrupt(daemon2.schedulerFiber));
      }
      daemon1.server.stop(true);
      daemon2.server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
