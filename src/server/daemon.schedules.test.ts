/**
 * Issue #16: the daemon forks the scheduler when its config has schedules.
 * The fire lands through the same `startTrackedRun` path as a manual start,
 * so the scheduled run appears in the runs list and records its schedule.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, type FactoryConfig } from "../config";
import { defineWorkflow, Schema } from "../workflow";
import { startDaemon } from "./daemon";

const SCHEDULED_ECHO = defineWorkflow("scheduled-echo", {
  input: Schema.Struct({ issueNumber: Schema.Number }),
  // A scratch workspace: the scheduler test needs neither mirrored git state
  // nor an agent — only that a scheduled run starts and records its trigger.
  workspace: { kind: "scratch" },
  run: async (ctx) => {
    await ctx.log("tick", { at: ctx.dir.length });
    return { ok: true };
  },
});

function testConfig(): FactoryConfig {
  return defineConfig({
    repo: {
      sshUrl: "git@github.com:acme/widgets.git",
      identity: { name: "Factory", email: "factory@acme.test" },
      baseBranch: "main",
      slug: "acme/widgets",
    },
    workflows: [SCHEDULED_ECHO],
    workspaceRoot: join(tmpdir(), `factory-sched-${Date.now()}`),
    schedules: [
      {
        id: "hourly-echo",
        workflow: "scheduled-echo",
        input: { issueNumber: 41 },
        cron: "0 0 9 * * *",
        timezone: "UTC",
        runOnStart: true,
      },
    ],
  });
}

describe("daemon schedules (issue #16)", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-sched-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a run-on-start schedule fires once per daemon start and the run records it", async () => {
    const handle = await startDaemon({
      dbPath: join(dir, "factory.db"),
      port: 0,
      schedulerIntervalMs: 20,
      config: testConfig(),
    });

    try {
      // Several scheduler intervals worth of ticks: run-on-start must still
      // be exactly one run.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const runsResponse = await fetch(`http://localhost:${handle.server.port}/api/runs`);
      const runs = (await runsResponse.json()) as Array<{
        runId: string;
        workflowId: string;
        scheduleId?: string;
        status: string;
      }>;
      const scheduled = runs.filter((run) => run.workflowId === "scheduled-echo");
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.scheduleId).toBe("hourly-echo");
      expect(scheduled[0]?.status).toBe("RunFinished");
    } finally {
      if (handle.schedulerFiber !== undefined) {
        Effect.runFork(Fiber.interrupt(handle.schedulerFiber));
      }
      handle.server.stop(true);
    }
  });
});
