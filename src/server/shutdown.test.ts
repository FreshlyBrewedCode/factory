/**
 * Shutdown cancels active runs (#38): `DaemonHandle.stop` — the path
 * `factory serve`'s SIGINT/SIGTERM handler takes — cancels every run the
 * daemon holds and waits for it to settle before the runtime goes away, so a
 * run ends as a recorded `RunCancelled` with its `ctx.exec` child killed,
 * rather than as an orphaned process and an "interrupted" run after restart.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defineConfig } from "../config";
import { RefreshGates } from "../lib/workspace";
import { getRunEvents, openStore } from "../persistence/store";
import { createSlowFakeAdapter } from "../replay/adapter";
import type { AgentAdapter, AgentAdapterYield } from "../runtime/agent-adapter";
import { makeAgentRuntime } from "../runtime/agent-runtime";
import { startRun } from "../runtime/run";
import type { RunEvent } from "../events";
import { defineWorkflow } from "../workflow";
import { startDaemon, type DaemonHandle } from "./daemon";
import { makeDaemonRuntime, serviceOf } from "./daemon-runtime";
import { RunRegistry, startTrackedRun } from "./runs";

/** Writes its shell's pid, then becomes a 300s sleep — a child that outlives any test. */
const longExec = defineWorkflow("shutdown-long-exec", {
  input: Schema.Struct({ pidFile: Schema.String }),
  workspace: { kind: "scratch" },
  run: async (ctx, input) => {
    await ctx.exec(["sh", "-c", `echo $$ > ${input.pidFile}; exec sleep 300`]);
    return {};
  },
});

/** The same, on a clone workspace, so its allocation can be held open. */
const cloneLongExec = defineWorkflow("shutdown-clone-long-exec", {
  input: Schema.Struct({}),
  run: async (ctx) => {
    await ctx.exec(["sleep", "300"]);
    return {};
  },
});

/** One agent step and nothing else: the run is mid-step until cancelled. */
const agentStep = defineWorkflow("shutdown-agent-step", {
  input: Schema.Struct({}),
  workspace: { kind: "scratch" },
  run: async (ctx) => {
    await ctx.agent("think", "waiting on the model");
    return {};
  },
});

/**
 * An adapter waiting on the model, like opencode between chunks: its
 * generator's `next()` is pending until the step's abort reaches it, then
 * takes `abortLatencyMs` to wind down (the HTTP `session.abort()` round trip)
 * before its `finally` — the process kill — runs. Before #38's fix the
 * stream's implicit `return()` queued behind that `next()`, and the abort that
 * would release it only fired after `return()` finished: a deadlock until the
 * next chunk. `cooperative: false` never ends at all, abort or not.
 */
function waitingAdapter(options: {
  readonly cooperative: boolean;
  readonly abortLatencyMs?: number;
}): AgentAdapter & {
  readonly tornDown: () => boolean;
} {
  let tornDown = false;
  return {
    tornDown: () => tornDown,
    async prepareWorkspace(): Promise<void> {},
    async *stream({ abortController }): AsyncIterable<AgentAdapterYield> {
      try {
        yield { chunk: { type: "RUN_STARTED" } };
        await new Promise<void>((resolve) => {
          if (!options.cooperative) return;
          abortController.signal.addEventListener("abort", () =>
            setTimeout(resolve, options.abortLatencyMs ?? 0),
          );
        });
      } finally {
        tornDown = true;
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met within timeout");
}

function tagsOf(dbPath: string, runId: string): Array<string> {
  const db = openStore(dbPath);
  try {
    return getRunEvents(db, runId).map((event) => event.payload._tag);
  } finally {
    db.close();
  }
}

async function makeDaemon(root: string, sshUrl = join(root, "no-remote")): Promise<DaemonHandle> {
  return startDaemon({
    dbPath: join(root, "factory.db"),
    port: 0,
    config: defineConfig({
      agent: { adapter: createSlowFakeAdapter([], 1) },
      repo: {
        sshUrl,
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [longExec, cloneLongExec],
      workspaceRoot: join(root, "workspaces"),
      retainedWorkspaces: 10,
    }),
  });
}

async function post(handle: DaemonHandle, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}/api/runs`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("daemon shutdown cancels active runs (#38)", () => {
  test("stop() cancels a running exec: RunCancelled is recorded and the child is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-shutdown-exec-"));
    const pidFile = join(root, "child.pid");
    const handle = await makeDaemon(root);
    try {
      const res = await post(handle, { workflowId: "shutdown-long-exec", input: { pidFile } });
      expect(res.status).toBe(201);
      const { runId } = (await res.json()) as { runId: string };

      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(isAlive(pid)).toBe(true);

      await handle.stop();

      expect(tagsOf(join(root, "factory.db"), runId).at(-1)).toBe("RunCancelled");
      expect(isAlive(pid)).toBe(false);
    } finally {
      await handle.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stop() cancels a reserved, allocation-bound run cleanly and refuses new starts meanwhile", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-shutdown-reserved-"));
    const seed = join(root, "seed");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q --allow-empty -m seed`.quiet();
    const handle = await makeDaemon(root, seed);

    // Hold allocation open: the mirror's refresh queues behind this gate, so
    // the run is a reserved slot and nothing more until it is released.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serviceOf(handle.runtime, RefreshGates).set(join(root, "workspaces", ".mirror.git"), gate);
    const registry = serviceOf(handle.runtime, RunRegistry);

    try {
      // The POST itself is held by the allocation, so it is not awaited here.
      const starting = post(handle, { workflowId: "shutdown-clone-long-exec", input: {} });
      await waitFor(() => registry.activeRunIds().length === 1);
      const runId = registry.activeRunIds()[0]!;
      expect(registry.getActiveHandle(runId)).toBeUndefined();

      let stopped = false;
      const stopping = handle.stop().then(() => {
        stopped = true;
      });

      // Shutdown is waiting on the reserved run, and admits nothing new.
      await Bun.sleep(50);
      expect(stopped).toBe(false);
      const refused = await post(handle, { workflowId: "shutdown-clone-long-exec", input: {} });
      expect(refused.status).toBe(503);

      release();
      await stopping;
      expect((await starting).status).toBe(201);

      expect(registry.activeRunIds()).toEqual([]);
      const tags = tagsOf(join(root, "factory.db"), runId);
      expect(tags[0]).toBe("RunStarted");
      expect(tags.at(-1)).toBe("RunCancelled");
      expect(tags).not.toContain("ExecStarted");
    } finally {
      release();
      await handle.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stop() is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-shutdown-idem-"));
    const pidFile = join(root, "child.pid");
    const handle = await makeDaemon(root);
    try {
      const res = await post(handle, { workflowId: "shutdown-long-exec", input: { pidFile } });
      const { runId } = (await res.json()) as { runId: string };
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");

      const first = handle.stop();
      const second = handle.stop();
      expect(second).toBe(first);
      await Promise.all([first, second]);
      await handle.stop();

      const tags = tagsOf(join(root, "factory.db"), runId);
      expect(tags.filter((tag) => tag === "RunCancelled")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("disposing a daemon runtime without stop() still cancels its runs (layer finalizer)", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-shutdown-dispose-"));
    const pidFile = join(root, "child.pid");
    const dbPath = join(root, "factory.db");
    const db = openStore(dbPath);
    const runtime = makeDaemonRuntime(createSlowFakeAdapter([], 1));
    try {
      const runId = await startTrackedRun(runtime, db, longExec, {
        workspace: {
          workspaceRoot: join(root, "workspaces"),
          sshUrl: join(root, "no-remote"),
          identity: { name: "T", email: "t@t.test" },
          retainedWorkspaces: 10,
        },
        input: { pidFile },
      });
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
      const pid = Number(readFileSync(pidFile, "utf8").trim());

      await runtime.dispose();

      expect(getRunEvents(db, runId).at(-1)?.payload._tag).toBe("RunCancelled");
      expect(isAlive(pid)).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a cancel mid-agent-step records RunCancelled promptly even if the adapter never yields again", async () => {
    const adapter = waitingAdapter({ cooperative: false });
    const events: Array<RunEvent> = [];
    const handle = startRun(agentStep, makeAgentRuntime(adapter), {
      runId: "run-blocked-agent",
      dir: tmpdir(),
      input: {},
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => events.some((e) => e.payload._tag === "AgentChunk"));

    const started = Date.now();
    await handle.cancel();
    expect(Date.now() - started).toBeLessThan(500);
    expect(events.at(-1)?.payload._tag).toBe("RunCancelled");
    expect(
      events.find((e) => e.payload._tag === "AgentStepFinished")?.payload as { outcome?: string },
    ).toMatchObject({ outcome: "cancelled" });
  });

  test("stop() mid-agent-step finishes well within budget and the adapter is torn down", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-shutdown-agent-"));
    const adapter = waitingAdapter({ cooperative: true, abortLatencyMs: 100 });
    const handle = await startDaemon({
      dbPath: join(root, "factory.db"),
      port: 0,
      config: defineConfig({
        agent: { adapter },
        repo: {
          sshUrl: join(root, "no-remote"),
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [agentStep],
        workspaceRoot: join(root, "workspaces"),
        retainedWorkspaces: 10,
      }),
    });
    try {
      const res = await post(handle, { workflowId: "shutdown-agent-step", input: {} });
      const { runId } = (await res.json()) as { runId: string };
      await waitFor(() => tagsOf(join(root, "factory.db"), runId).includes("AgentChunk"));

      const started = Date.now();
      await handle.stop();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(tagsOf(join(root, "factory.db"), runId).at(-1)).toBe("RunCancelled");
      // stop() waited for the adapter's own teardown, not just the run's end.
      expect(adapter.tornDown()).toBe(true);
    } finally {
      await handle.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
