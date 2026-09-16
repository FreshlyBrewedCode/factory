import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defineConfig } from "./config";
import { getRunEvents, openStore } from "./persistence/store";
import { createSlowFakeAdapter } from "./replay/adapter";
import registryWorkflow from "../test/fixtures/registry-workflow";
import { startDaemon } from "./server/daemon";

const CLI = `${import.meta.dir}/cli.ts`;

interface TestDaemon {
  readonly base: string;
  readonly dbPath: string;
  readonly stop: () => Promise<void>;
}

async function startTestDaemon(delayMs: number, root: string): Promise<TestDaemon> {
  const seed = join(root, "seed-repo");
  await Bun.$`git init -b main -q ${seed}`.quiet();
  await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q --allow-empty -m seed`.quiet();

  const dbPath = join(root, "factory.db");
  const daemon = await startDaemon({
    dbPath,
    port: 0,
    adapter: createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      delayMs,
    ),
    config: defineConfig({
      repo: {
        sshUrl: seed,
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [registryWorkflow],
      workspaceRoot: join(root, "workspaces"),
      maxConcurrentRuns: 4,
      retainedWorkspaces: 10,
    }),
  });
  return {
    base: `http://localhost:${daemon.server.port}`,
    dbPath,
    stop: async () => {
      await daemon.server.stop(true);
    },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("factory start (D31): thin HTTP client against a real daemon", () => {
  test("POSTs {workflowId, input} and prints the returned runId", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-start-"));
    const daemon = await startTestDaemon(1, root);

    try {
      const proc = Bun.spawn(
        [
          "bun",
          CLI,
          "start",
          "registry-test",
          "--input",
          '{"issueNumber":7}',
          "--url",
          daemon.base,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      const stdout = await readAll(proc.stdout);
      const runId = stdout.trim().split("\n").at(-1);
      expect(runId).toMatch(/^run-/);

      const db = openStore(daemon.dbPath);
      const events = await (async () => {
        for (let i = 0; i < 200; i++) {
          const events = getRunEvents(db, runId!);
          if (events.some((e) => e.payload._tag === "RunFinished")) return events;
          await Bun.sleep(25);
        }
        throw new Error(`run ${runId} never reached RunFinished`);
      })();
      expect(events.map((e) => e.payload._tag)).toContain("RunStarted");
      db.close();
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("--watch tails SSE until a terminal event", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-start-watch-"));
    const daemon = await startTestDaemon(150, root);

    try {
      const proc = Bun.spawn(
        [
          "bun",
          CLI,
          "start",
          "registry-test",
          "--input",
          '{"issueNumber":8}',
          "--url",
          daemon.base,
          "--watch",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      const stdout = await readAll(proc.stdout);
      expect(stdout).toContain("RunStarted");
      expect(stdout).toContain("AgentStepFinished");
      expect(stdout).toContain("RunFinished");
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("unknown workflow id maps 404 to a non-zero exit and stderr", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-start-404-"));
    const daemon = await startTestDaemon(1, root);

    try {
      const proc = Bun.spawn(
        ["bun", CLI, "start", "no-such-workflow", "--input", "{}", "--url", daemon.base],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;

      expect(exitCode).not.toBe(0);
      expect(await readAll(proc.stderr)).toContain("no-such-workflow");
      expect(await readAll(proc.stdout)).toBe("");
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("watchSse skips malformed frames (L2) and still exits 0 on the terminal event", async () => {
    // A raw Bun.serve emitting exactly one malformed data frame, then a valid
    // terminal frame — what the CLI must survive rather than crash on.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          [
            "data: not-json-at-all\n\n",
            `data: ${JSON.stringify({
              runId: "run-x",
              seq: 0,
              ts: 1,
              payload: { _tag: "RunFinished", durationMs: 1 },
            })}\n\n`,
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const base = `http://localhost:${server.port}`;

    try {
      const { watchSse } = await import("./cli");
      const stderr: Array<string> = [];
      const originalError = console.error;
      console.error = (line: string) => stderr.push(line);
      const exit = await watchSse(base, "run-x");
      console.error = originalError;

      expect(exit).toBe(0);
      expect(stderr.join("\n")).toContain("skipping malformed frame");
    } finally {
      await server.stop(true);
    }
  });

  test("watchSse survives more drops than its budget when each one makes progress", async () => {
    /*
     * The counter in the original reconnect fix never reset, so a run with more
     * quiet gaps than the budget died mid-tail even though the daemon was
     * healthy — the same defect the SPA had, in the CLI. Five drops against a
     * budget of three: this only reaches the terminal event if progress refills
     * the budget.
     *
     * Each connection here also asserts the resume: it must arrive carrying the
     * last seq the CLI saw, so the tail continues rather than reprinting the
     * run from the top on every reconnect.
     */
    const resumeOffsets: Array<string | null> = [];
    const encoder = new TextEncoder();
    const frames = [0, 1, 2, 3, 4].map(
      (seq) =>
        `id: ${seq}\ndata: ${JSON.stringify({
          runId: "run-x",
          seq,
          ts: seq,
          payload: { _tag: "LogRecorded", name: `step-${seq}`, data: {} },
        })}\n\n`,
    );
    const terminal = `id: 5\ndata: ${JSON.stringify({
      runId: "run-x",
      seq: 5,
      ts: 5,
      payload: { _tag: "RunFinished", durationMs: 1 },
    })}\n\n`;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const attempt = resumeOffsets.length;
        resumeOffsets.push(req.headers.get("last-event-id"));
        return new Response(
          new ReadableStream({
            start(controller) {
              if (attempt < frames.length) {
                controller.enqueue(encoder.encode(frames[attempt]!));
                setTimeout(() => controller.error(), 5);
                return;
              }
              controller.enqueue(encoder.encode(terminal));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const base = `http://localhost:${server.port}`;

    try {
      const { watchSse } = await import("./cli");
      const originalLog = console.log;
      const originalError = console.error;
      const stdout: Array<string> = [];
      console.log = (line: string) => stdout.push(line);
      console.error = () => undefined;
      const exit = await watchSse(base, "run-x", { reconnectDelayMs: 1 });
      console.log = originalLog;
      console.error = originalError;

      expect(exit).toBe(0);
      // Six connections: five dropped, the last one terminal.
      expect(resumeOffsets).toEqual([null, "0", "1", "2", "3", "4"]);
      // And no event printed twice — the resume means no re-replay.
      expect(stdout).toHaveLength(6);
    } finally {
      await server.stop(true);
    }
  }, 15_000);
});
