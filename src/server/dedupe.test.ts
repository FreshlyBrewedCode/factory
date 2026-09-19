/**
 * Issue #15, server side: `startTrackedRun` claims its `dedupeKey` before any
 * await (so a concurrent start with the same key cannot lose the race) and
 * releases it when the run reaches any terminal state. Starting a second run
 * with a key a non-terminal run already holds throws a `DedupeKeyError`
 * naming the key and the holding run.
 *
 * #38: tests create their own DaemonServices instead of using module-level
 * singletons or test seams. The `beforeStart` test seam is gone — tests
 * reserve registry slots directly to test the reserved-but-not-started
 * window.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openStore, getRunEvents } from "../persistence/store";
import { createSlowFakeAdapter } from "../replay/adapter";
import { makeAgentRuntime } from "../runtime/agent-runtime";
import { defineWorkflow, Schema } from "../workflow";
import { createDedupeRegistry, DedupeKeyError } from "../lib/dedupe";
import { createRunRegistry, startTrackedRun, type DaemonServices } from "./runs";
import { createPubSub } from "./pubsub";
import { createRefreshGates } from "../lib/workspace";
import { serve } from "./http";
import { defineConfig } from "../config";

async function drain(services: DaemonServices, timeoutMs = 10_000): Promise<void> {
  await waitFor(() => services.registry.activeRunIds().length === 0, timeoutMs);
}

const SLOW_ADAPTER = createSlowFakeAdapter(
  [
    { type: "TEXT_MESSAGE_START" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
    { type: "TEXT_MESSAGE_END" },
  ],
  25,
);

const runtime = makeAgentRuntime(SLOW_ADAPTER);

const echoWorkflow = defineWorkflow("echo-wf", {
  input: Schema.Struct({}),
  run: async (ctx) => {
    const result = await ctx.agent("step", "irrelevant, replay ignores it");
    return { finalText: result.finalText };
  },
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met within timeout");
}

function createTestServices(): DaemonServices {
  return {
    registry: createRunRegistry(),
    pubsub: createPubSub(),
    dedupeRegistry: createDedupeRegistry(),
    refreshGates: createRefreshGates(),
  };
}

interface StartOpts {
  readonly runId?: string;
  readonly dir: string;
  readonly dedupeKey?: string;
  readonly services: DaemonServices;
}

function start(db: ReturnType<typeof openStore>, opts: StartOpts): Promise<string> {
  return startTrackedRun(runtime, db, opts.services, echoWorkflow, {
    dir: opts.dir,
    input: {},
    maxConcurrentRuns: 4,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
  });
}

async function errorOf(promise: Promise<string>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (err: unknown) => err,
  );
}

interface WorkspaceSpec {
  readonly workspaceRoot: string;
  readonly sshUrl: string;
  readonly identity: { readonly name: string; readonly email: string };
  readonly retainedWorkspaces: number;
}

function workspaces(root: string): WorkspaceSpec {
  return {
    workspaceRoot: join(root, "workspaces"),
    sshUrl: join(root, "seed-not-used"),
    identity: { name: "Test Bot", email: "test@factory.local" },
    retainedWorkspaces: 10,
  };
}

function withWorkspaces(root: string): Record<string, unknown> {
  return {
    workspace: workspaces(root),
    maxConcurrentRuns: 10,
  };
}

describe("dedupe keys through ctx.dispatch (issue #15)", () => {
  const driftAdapter = SLOW_ADAPTER;
  const busyWorkflow = defineWorkflow("busy-wf", {
    input: Schema.Struct({ n: Schema.Number }),
    workspace: { kind: "scratch" },
    run: async (ctx) => {
      await ctx.exec(["sh", "-c", "sleep 0.2"]);
      return { n: 1 };
    },
  });

  test("a ctx.dispatch collision throws into the parent and is recorded as DispatchCollision", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-dispatch-"));
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "workspaces"), { recursive: true });
    const services = createTestServices();

    const parent = defineWorkflow("parent-wf", {
      input: Schema.Struct({ wait: Schema.Number }),
      workspace: { kind: "scratch" },
      run: async (ctx, input) => {
        const childRunId = await ctx.dispatch(
          busyWorkflow,
          { n: input.wait },
          { dedupeKey: "item:7" },
        );
        await ctx.dispatch(busyWorkflow, { n: input.wait }, { dedupeKey: "item:7" });
        return { childRunId };
      },
    });

    const parentRunId = await startTrackedRun(runtime, db, services, parent, {
      input: { wait: 3 },
      workspace: workspaces(join(root)),
      maxConcurrentRuns: 10,
      dispatchEnv: { ...withWorkspaces(join(root)), adapter: driftAdapter } as never,
    });

    await waitFor(() => !services.registry.isActive(parentRunId));

    const events = getRunEvents(db, parentRunId);
    const collided = events.find((event) => event.payload._tag === "DispatchCollision");
    expect(collided).toBeDefined();
    if (collided !== undefined && collided.payload._tag === "DispatchCollision") {
      expect(collided.payload.key).toBe("item:7");
      expect(collided.payload.holderRunId).toBeTypeOf("string");
      expect(collided.payload.childWorkflowId).toBe("busy-wf");
    }
    const failed = events.find((event) => event.payload._tag === "RunFailed");
    expect(
      failed !== undefined && failed.payload._tag === "RunFailed" ? failed.payload.message : "",
    ).toMatch(/dedupe key held: "item:7"/);

    await drain(services);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the key is released when the holding child run finishes, so a later dispatch succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-dispatch-release-"));
    const db = openStore(join(root, "factory.db"));
    mkdirSync(join(root, "workspaces"), { recursive: true });
    const services = createTestServices();

    let releaseHeldWorkflow: () => void = () => undefined;
    const heldWorkflowGate = new Promise<void>((resolve) => {
      releaseHeldWorkflow = resolve;
    });
    const heldWorkflow = defineWorkflow("held-wf", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async () => {
        await heldWorkflowGate;
        return {};
      },
    });

    let releaseParent: () => void = () => undefined;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });

    const parent = defineWorkflow("parent-release-wf", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        const ids = [];
        ids.push(await ctx.dispatch(heldWorkflow, {}, { dedupeKey: "item:8" }));
        await parentGate;
        ids.push(await ctx.dispatch(heldWorkflow, {}, { dedupeKey: "item:8" }));
        return { ids };
      },
    });

    const parentRunId = (await startTrackedRun(runtime, db, services, parent, {
      input: {},
      workspace: workspaces(join(root)),
      maxConcurrentRuns: 10,
      dispatchEnv: { ...withWorkspaces(join(root)), adapter: driftAdapter } as never,
    })) as string;

    await waitFor(() =>
      getRunEvents(db, parentRunId).some((event) => event.payload._tag === "RunDispatched"),
    );
    await Bun.sleep(150);
    releaseHeldWorkflow();
    await Bun.sleep(50);
    releaseParent();
    await waitFor(
      () =>
        getRunEvents(db, parentRunId).filter((event) => event.payload._tag === "RunDispatched")
          .length >= 2,
      10_000,
    );
    await waitFor(() => !services.registry.isActive(parentRunId));

    const dispatchedCount = getRunEvents(db, parentRunId).filter(
      (event) => event.payload._tag === "RunDispatched",
    ).length;
    expect(dispatchedCount).toBeGreaterThanOrEqual(2);
    expect(
      getRunEvents(db, parentRunId).some((event) => event.payload._tag === "DispatchCollision"),
    ).toBe(false);

    await drain(services);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("dedupe keys through startTrackedRun (issue #15)", () => {
  test("a key held by a non-terminal run rejects a second start with key and holder named", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-hold-"));
    const db = openStore(join(root, "factory.db"));
    const services = createTestServices();

    services.registry.reserve("run-holder");
    services.dedupeRegistry.claim("item:41", "run-holder");

    const err = (await errorOf(
      start(db, { runId: "run-collide", dir: join(root, "dir-2"), dedupeKey: "item:41", services }),
    )) as DedupeKeyError | string;
    expect(err).toBeInstanceOf(DedupeKeyError);
    if (err instanceof DedupeKeyError) {
      expect(err.key).toBe("item:41");
      expect(err.holderRunId).toBe("run-holder");
      expect(err.message).toContain("item:41");
      expect(err.message).toContain("run-holder");
    }

    services.registry.delete("run-holder");
    services.dedupeRegistry.release("item:41", "run-holder");

    const firstRunId = await start(db, {
      runId: "run-holder",
      dir: join(root, "dir-1"),
      dedupeKey: "item:41",
      services,
    });
    await waitFor(() => !services.registry.isActive(firstRunId));

    await drain(services);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the holder's RunStarted carries the key; a rejected start leaves no lifecycle trace", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-log-"));
    const db = openStore(join(root, "factory.db"));
    const services = createTestServices();

    const firstRunId = await start(db, {
      runId: "run-holder",
      dir: join(root, "dir-1"),
      dedupeKey: "item:42",
      services,
    });

    await errorOf(
      start(db, { runId: "run-collide", dir: join(root, "dir-2"), dedupeKey: "item:42", services }),
    );

    await waitFor(() => !services.registry.isActive(firstRunId));

    const holderStarted = getRunEvents(db, "run-holder").find(
      (e) => e.payload._tag === "RunStarted",
    );

    expect(holderStarted !== undefined && holderStarted.payload._tag === "RunStarted").toBe(true);
    expect(
      holderStarted !== undefined && holderStarted.payload._tag === "RunStarted"
        ? holderStarted.payload.dedupeKey
        : "missing",
    ).toBe("item:42");
    expect(getRunEvents(db, "run-collide")).toHaveLength(0);

    await drain(services);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the key is released when the holding run reaches its terminal state", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-finish-"));
    const db = openStore(join(root, "factory.db"));
    const services = createTestServices();

    const firstRunId = await start(db, {
      dir: join(root, "dir-1"),
      dedupeKey: "item:43",
      services,
    });
    expect(firstRunId).toBeTypeOf("string");
    await waitFor(() => !services.registry.isActive(firstRunId));

    const retryRunId = await start(db, {
      dir: join(root, "dir-2"),
      dedupeKey: "item:43",
      services,
    });
    await waitFor(() => !services.registry.isActive(retryRunId));
    expect(getRunEvents(db, retryRunId).some((e) => e.payload._tag === "RunStarted")).toBe(true);

    await drain(services);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a failed start releases its claim so a corrected retry can start", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-fail-"));
    const db = openStore(join(root, "factory.db"));
    const services = createTestServices();

    await expect(
      startTrackedRun(runtime, db, services, echoWorkflow, {
        input: {},
        dedupeKey: "item:44",
      }),
    ).rejects.toThrow(/needs `dir` or `workspace`/);

    const retryRunId = await start(db, {
      dir: join(root, "dir-1"),
      dedupeKey: "item:44",
      services,
    });
    await waitFor(() => !services.registry.isActive(retryRunId));
    expect(getRunEvents(db, retryRunId).some((e) => e.payload._tag === "RunStarted")).toBe(true);

    await drain(services);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a cancelled run releases its key (RunCancelled is a terminal state)", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-cancel-"));
    const db = openStore(join(root, "factory.db"));
    const services = createTestServices();

    const holderRunId = await startTrackedRun(runtime, db, services, echoWorkflow, {
      runId: "run-cancelled",
      dir: join(root, "dir-1"),
      input: {},
      dedupeKey: "item:45",
    });
    await waitFor(() => !services.registry.isActive(holderRunId) || true);
    const handle = services.registry.getActiveHandle("run-cancelled");
    expect(handle).toBeDefined();
    if (handle !== undefined) await handle.cancel();

    await waitFor(() => !services.registry.isActive(holderRunId));
    const started = getRunEvents(db, holderRunId).some((e) => e.payload._tag === "RunStarted");
    const retryRunId = await startTrackedRun(runtime, db, services, echoWorkflow, {
      dir: join(root, "dir-2"),
      input: {},
      dedupeKey: "item:45",
    });
    expect(started).toBe(true);
    expect(retryRunId).toBeTypeOf("string");
    await drain(services);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("runs started without a key behave exactly as before", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-none-"));
    const db = openStore(join(root, "factory.db"));
    const services = createTestServices();

    const firstRunId = await start(db, { dir: join(root, "dir-1"), services });
    const secondRunId = await start(db, { dir: join(root, "dir-2"), services });
    expect(firstRunId).toBeTypeOf("string");
    expect(secondRunId).toBeTypeOf("string");
    await waitFor(
      () => !services.registry.isActive(firstRunId) && !services.registry.isActive(secondRunId),
    );

    await drain(services);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

async function waitForTerminalStatus(
  db: ReturnType<typeof openStore>,
  runId: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(
    () =>
      getRunEvents(db, runId).some((event) =>
        ["RunFinished", "RunFailed", "RunCancelled"].includes(event.payload._tag),
      ),
    timeoutMs,
  );
}

describe("dedupe keys over POST /api/runs (issue #15)", () => {
  test("a key held by a running run surfaces as a 409 conflict naming the key and the holder", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-http-"));
    const db = openStore(join(root, "factory.db"));
    const services = createTestServices();

    const slowStartWorkflow = defineWorkflow("dedupe-http-slow", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        await ctx.exec(["sh", "-c", "sleep 0.5"]);
        return {};
      },
    });

    const server = serve({
      runtime,
      db,
      services,
      port: 0,
      config: defineConfig({
        repo: {
          sshUrl: join(root, "seed-not-used"),
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [slowStartWorkflow],
        workspaceRoot: join(root, "workspaces"),
        retainedWorkspaces: 10,
      }),
    });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "dedupe-http-slow", input: {}, dedupeKey: "issue:91" }),
      });
      expect(startRes.status).toBe(201);
      const { runId: holderRunId } = (await startRes.json()) as { runId: string };

      const collideRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({
          workflowId: "dedupe-http-slow",
          input: {},
          dedupeKey: "issue:91",
        }),
      });
      expect(collideRes.status).toBe(409);
      const collision = (await collideRes.json()) as {
        error: string;
        dedupeKey: string;
        holderRunId: string;
      };
      expect(collision.dedupeKey).toBe("issue:91");
      expect(collision.holderRunId).toBe(holderRunId);
      expect(collision.error).toContain("issue:91");
      expect(collision.error).toContain(holderRunId);

      expect(getRunEvents(db, "nonexistent")).toHaveLength(0);

      await waitForTerminalStatus(db, holderRunId);
      const retryRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "dedupe-http-slow", input: {}, dedupeKey: "issue:91" }),
      });
      expect(retryRes.status).toBe(201);
      const { runId: retryRunId } = (await retryRes.json()) as { runId: string };
      await waitForTerminalStatus(db, retryRunId);
    } finally {
      await drain(services);
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a non-string dedupeKey is a 400, and omitting one behaves as today", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-dedupe-http-shape-"));
    const db = openStore(join(root, "factory.db"));
    const services = createTestServices();
    const plainWorkflow = defineWorkflow("dedupe-http-plain", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async () => ({}),
    });

    const server = serve({
      runtime,
      db,
      services,
      port: 0,
      config: defineConfig({
        repo: {
          sshUrl: join(root, "seed-not-used"),
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [plainWorkflow],
        workspaceRoot: join(root, "workspaces"),
        retainedWorkspaces: 10,
      }),
    });
    const base = `http://localhost:${server.port}`;

    try {
      const bad = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "dedupe-http-plain", input: {}, dedupeKey: 7 }),
      });
      expect(bad.status).toBe(400);

      const plain = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "dedupe-http-plain", input: {} }),
      });
      expect(plain.status).toBe(201);
      const { runId } = (await plain.json()) as { runId: string };
      await waitForTerminalStatus(db, runId);
    } finally {
      await drain(services);
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
