/**
 * Phase 5 P1's integration criterion: two concurrent runs through the real
 * server (`serve()` over Bun.serve, real sqlite event log), each allocated
 * its own working tree from a local seed repo (the D28 stand-in for the
 * configured sshUrl — `git clone` accepts local paths, so no network is
 * involved). Asserts the event logs stay disjoint and both trees end up
 * independently intact.
 *
 * The adapters mix: one run rides a slow fake (stays in flight long enough
 * to overlap), the other replays a recorded corpus (phase 1's finish step →
 * two `ctx.agent` calls, matching the fixture's two). Started via
 * `POST /api/runs` over real fetch — nothing mocks fetch.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defineConfig } from "../config";
import { getRunEvents, openStore } from "../persistence/store";
import { createSlowFakeAdapter } from "../replay/adapter";
import { admitRun } from "./admission";
import { serve } from "./http";

const TREE_WORKFLOW = `${import.meta.dir}/../../test/fixtures/tree-workflow.ts`;

async function startViaApi(
  base: string,
  workflowPath: string,
  input: unknown,
): Promise<{ status: number; runId?: string }> {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    body: JSON.stringify({ workflowPath, input }),
  });
  const body = (await res.json()) as { runId?: string };
  return { status: res.status, runId: body.runId };
}

async function isTerminalInStore(
  db: ReturnType<typeof openStore>,
  runId: string,
): Promise<boolean> {
  return getRunEvents(db, runId).some((e) =>
    ["RunFinished", "RunFailed", "RunCancelled"].includes(e.payload._tag),
  );
}

async function waitForTerminal(
  db: ReturnType<typeof openStore>,
  runId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTerminalInStore(db, runId)) return;
    await Bun.sleep(25);
  }
  throw new Error(`run ${runId} did not reach a terminal state within ${timeoutMs}ms`);
}

describe("phase 5 P1: per-run working trees (D28) over the real server", () => {
  test("two concurrent runs get independently intact trees and disjoint event logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-p1-concurrent-"));
    const seed = join(root, "seed-repo");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    await Bun.$`echo base > ${join(seed, "base.txt")}`.quiet();
    await Bun.$`git -C ${seed} add base.txt`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q -m seed`.quiet();

    const workspaceRoot = join(root, "workspaces");
    const db = openStore(join(root, "factory.db"));
    const server = serve({
      db,
      adapter: createSlowFakeAdapter(
        [
          { type: "TEXT_MESSAGE_START" },
          { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
          { type: "TEXT_MESSAGE_END" },
        ],
        30,
      ),
      port: 0,
      config: defineConfig({
        repo: {
          sshUrl: seed,
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [],
        workspaceRoot,
        maxConcurrentRuns: 4,
        retainedWorkspaces: 10,
      }),
    });
    const base = `http://localhost:${server.port}`;

    try {
      const [first, second] = await Promise.all([
        startViaApi(base, TREE_WORKFLOW, { marker: "alpha" }),
        startViaApi(base, TREE_WORKFLOW, { marker: "beta" }),
      ]);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.runId).not.toBe(second.runId);

      const entries = readdirSync(workspaceRoot)
        .filter((e) => e !== ".mirror.git")
        .sort();
      expect(entries).toEqual([first.runId ?? "", second.runId ?? ""].sort());

      await waitForTerminal(db, first.runId!, 10_000);
      await waitForTerminal(db, second.runId!, 10_000);

      const alphaDir = join(workspaceRoot, first.runId!);
      const betaDir = join(workspaceRoot, second.runId!);
      expect(readFileSync(join(alphaDir, "alpha.txt"), "utf8")).toContain("alpha");
      expect(readFileSync(join(betaDir, "beta.txt"), "utf8")).toContain("beta");
      expect(existsSync(join(alphaDir, "beta.txt"))).toBe(false);
      expect(existsSync(join(betaDir, "alpha.txt"))).toBe(false);

      const alphaEvents = getRunEvents(db, first.runId!);
      const betaEvents = getRunEvents(db, second.runId!);
      expect(alphaEvents.map((e) => e.payload._tag)).toContain("RunFinished");
      expect(betaEvents.map((e) => e.payload._tag)).toContain("RunFinished");

      const alphaStart = alphaEvents.find((e) => e.payload._tag === "RunStarted");
      const betaStart = betaEvents.find((e) => e.payload._tag === "RunStarted");
      expect(
        alphaStart !== undefined && JSON.stringify(alphaStart.payload).includes(first.runId!),
      ).toBe(true);
      expect(
        betaStart !== undefined && JSON.stringify(betaStart.payload).includes(second.runId!),
      ).toBe(true);

      const distinctDirs = new Set(
        [...alphaEvents, ...betaEvents]
          .filter((e) => e.payload._tag === "RunStarted")
          .map((e) => (e.payload as { dir: string }).dir),
      );
      expect(distinctDirs.size).toBe(2);

      expect(readFileSync(join(alphaDir, "alpha.final.txt"), "utf8")).toContain("final-alpha");
      expect(readFileSync(join(betaDir, "beta.final.txt"), "utf8")).toContain("final-beta");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/runs returns 409 once the admission limit is reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-p1-admission-"));
    const seed = join(root, "seed-repo");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q --allow-empty -m seed`.quiet();

    const db = openStore(join(root, "factory.db"));
    const server = serve({
      db,
      adapter: createSlowFakeAdapter(
        [
          { type: "TEXT_MESSAGE_START" },
          { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
          { type: "TEXT_MESSAGE_END" },
        ],
        300,
      ),
      port: 0,
      config: defineConfig({
        repo: {
          sshUrl: seed,
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [],
        workspaceRoot: join(root, "workspaces"),
        maxConcurrentRuns: 1,
        retainedWorkspaces: 10,
      }),
    });
    const base = `http://localhost:${server.port}`;
    const ECHO_WORKFLOW = `${import.meta.dir}/../../test/fixtures/echo-workflow.ts`;

    try {
      const first = await startViaApi(base, ECHO_WORKFLOW, {});
      expect(first.status).toBe(201);

      expect(admitRun(1, 1)).toBe(false);

      const second = await startViaApi(base, ECHO_WORKFLOW, {});
      expect(second.status).toBe(409);
      const body = (await fetch(`${base}/api/runs/${first.runId}`).then((r) => r.json())) as {
        active: boolean;
      };
      expect(body.active).toBe(true);

      await waitForTerminal(db, first.runId!, 10_000);

      const after = await startViaApi(base, ECHO_WORKFLOW, {});
      expect(after.status).toBe(201);
      await waitForTerminal(db, after.runId!, 10_000);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("two near-simultaneous POSTs at the limit yield exactly one 201 and one 409 (M1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-p1-admission-race-"));
    const seed = join(root, "seed-repo");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q --allow-empty -m seed`.quiet();

    const workspaceRoot = join(root, "workspaces");
    const db = openStore(join(root, "factory.db"));
    const server = serve({
      db,
      adapter: createSlowFakeAdapter(
        [
          { type: "TEXT_MESSAGE_START" },
          { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
          { type: "TEXT_MESSAGE_END" },
        ],
        1_000,
      ),
      port: 0,
      config: defineConfig({
        repo: {
          sshUrl: seed,
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [],
        workspaceRoot,
        maxConcurrentRuns: 1,
        retainedWorkspaces: 10,
      }),
    });
    const base = `http://localhost:${server.port}`;
    const ECHO_WORKFLOW = `${import.meta.dir}/../../test/fixtures/echo-workflow.ts`;

    try {
      const [a, b] = await Promise.all([
        startViaApi(base, ECHO_WORKFLOW, {}),
        startViaApi(base, ECHO_WORKFLOW, {}),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const started = [a, b].find((r) => r.status === 201);
      expect(started?.runId).toMatch(/^run-/);

      await waitForTerminal(db, started!.runId!, 15_000);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
