import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defineWorkflow, type WorkflowDefinition } from "../workflow";
import { createSlowFakeAdapter } from "../replay/adapter";
import { getRunEvents, openStore } from "../persistence/store";
import { defineConfig, loadFactoryConfig } from "../config";
import registryWorkflow from "../../test/fixtures/registry-workflow";
import registryScratchWorkflow from "../../test/fixtures/registry-scratch-workflow";
import { serve } from "./http";

const ECHO_WORKFLOW = `${import.meta.dir}/../../test/fixtures/echo-workflow.ts`;
const QUIET_GAP_WORKFLOW = `${import.meta.dir}/../../test/fixtures/quiet-gap-workflow.ts`;
const FIXTURE_CONFIG = `${import.meta.dir}/../../test/fixtures/factory.config.ts`;

async function waitForTerminal(
  db: ReturnType<typeof openStore>,
  runId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = getRunEvents(db, runId).some((e) =>
      ["RunFinished", "RunFailed", "RunCancelled"].includes(e.payload._tag),
    );
    if (done) return;
    await Bun.sleep(25);
  }
  throw new Error(`run ${runId} did not reach a terminal state within ${timeoutMs}ms`);
}

interface SseFrame {
  /** The frame's `id:` line, i.e. the event's `seq` — `undefined` today is the G3 bug. */
  readonly id: number | undefined;
  readonly seq: number;
  readonly tag: string;
}

function parseFrame(raw: string): SseFrame | undefined {
  let id: number | undefined;
  let data: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice("id:".length).trim());
    else if (line.startsWith("data:")) data = line.slice("data:".length).trimStart();
  }
  if (data === undefined) return undefined;
  const event = JSON.parse(data) as { seq: number; payload: { _tag: string } };
  return { id, seq: event.seq, tag: event.payload._tag };
}

async function readSseUntilTerminal(
  url: string,
  headers?: Record<string, string>,
): Promise<ReadonlyArray<SseFrame>> {
  const res = await fetch(url, headers === undefined ? undefined : { headers });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<SseFrame> = [];
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);

    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame = parseFrame(raw);
      if (frame !== undefined) {
        frames.push(frame);
        if (["RunFinished", "RunFailed", "RunCancelled"].includes(frame.tag)) {
          reader.releaseLock();
          return frames;
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  return frames;
}

describe("GET /api/workflows (D30)", () => {
  test("lists the config's workflows with id and JSON Schema input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-workflows-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter([], 1);
    const config = await loadFactoryConfig(FIXTURE_CONFIG);
    const server = serve({ db, adapter, port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/workflows`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const workflows = (await res.json()) as Array<{
        id: string;
        inputSchema: { type: string; properties: Record<string, unknown> };
      }>;
      expect(workflows.map((w) => w.id)).toEqual(["registry-test"]);
      expect(workflows[0]!.inputSchema.type).toBe("object");
      expect(workflows[0]!.inputSchema.properties).toHaveProperty("issueNumber");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("404s for a POST to a legacy no-config server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-workflows-empty-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter([], 1);
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "registry-test", input: {} }),
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serves an empty list with no config (legacy path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-workflows-empty-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter([], 1);
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/workflows`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("phase 4 SPA serving", () => {
  test("serves the bundled SPA at / and deep links, and /api/* same-origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-spa-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter([{ type: "TEXT_MESSAGE_START" }], 1);
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const rootRes = await fetch(`${base}/`);
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get("content-type")).toContain("text/html");
      expect(await rootRes.text()).toContain('id="root"');

      // A client-side route that the server never sees on a fresh load still
      // has to return the SPA shell, not a 404.
      const deepRes = await fetch(`${base}/dispatch`);
      expect(deepRes.status).toBe(200);
      expect(deepRes.headers.get("content-type")).toContain("text/html");
      expect(await deepRes.text()).toContain('id="root"');

      // The SPA is served by the same origin as the API — no CORS involved.
      const apiRes = await fetch(`${base}/api/runs`);
      expect(apiRes.status).toBe(200);
      expect(apiRes.headers.get("content-type")).toContain("application/json");
      expect(await apiRes.json()).toEqual([]);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Reads the raw SSE bytes as well as the parsed frames, because the keepalive
 * is a *comment* frame — by design it is invisible to `parseFrame`, so only the
 * raw text can attest that it was sent.
 */
async function readSseRawUntilTerminal(
  url: string,
): Promise<{ raw: string; frames: ReadonlyArray<SseFrame> }> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<SseFrame> = [];
  let raw = "";
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    buffer += text;

    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = parseFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (frame !== undefined) {
        frames.push(frame);
        if (["RunFinished", "RunFailed", "RunCancelled"].includes(frame.tag)) {
          reader.releaseLock();
          return { raw, frames };
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  return { raw, frames };
}

describe("SSE keepalive", () => {
  /*
   * Bun.serve's `idleTimeout` defaults to 10 seconds and kills any connection
   * with no traffic, so a run that goes quiet longer than that — `ctx.exec`
   * running a test suite, write-back pushing — loses its SSE stream while the
   * run itself is perfectly healthy. The SPA then renders the run as
   * "interrupted" until someone refreshes. The fix is a comment frame on a
   * timer; this test turns the interval down so a sub-second gap exercises it.
   */
  test("keeps a quiet live run's stream open with comment frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-sse-keepalive-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter([], 1);
    const server = serve({ db, adapter, port: 0, sseKeepaliveMs: 25 });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowPath: QUIET_GAP_WORKFLOW, input: {}, dir }),
      });
      expect(startRes.status).toBe(201);
      const { runId } = (await startRes.json()) as { runId: string };

      const { raw, frames } = await readSseRawUntilTerminal(`${base}/api/runs/${runId}/events`);

      // The 400ms exec gap at a 25ms interval is many keepalives; two is
      // enough to prove the timer runs and keeps running.
      const keepalives = raw.split(":keepalive\n\n").length - 1;
      expect(keepalives).toBeGreaterThanOrEqual(2);

      // The run still completes, and the comment frames are inert to the
      // client parser — no phantom events, no corrupted ones.
      const tags = frames.map((f) => f.tag);
      expect(tags).toContain("ExecStarted");
      expect(tags).toContain("ExecFinished");
      expect(tags).toContain("RunFinished");
      expect(frames.every((f) => f.seq >= 0)).toBe(true);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stops the keepalive timer once the stream closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-sse-keepalive-stop-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter([], 1);
    const server = serve({ db, adapter, port: 0, sseKeepaliveMs: 10 });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowPath: ECHO_WORKFLOW, input: {}, dir }),
      });
      const { runId } = (await startRes.json()) as { runId: string };
      await waitForTerminal(db, runId, 10_000);

      // A finished run's stream closes after its replay. If the timer outlived
      // the close it would enqueue into a closed controller — the exact shape
      // of the P4-era crash — so the daemon must still be answering after
      // several intervals have elapsed.
      await readSseUntilTerminal(`${base}/api/runs/${runId}/events`);
      await Bun.sleep(60);

      const res = await fetch(`${base}/api/runs`);
      expect(res.status).toBe(200);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("phase 3 HTTP API + SSE", () => {
  test("start a run, list it, replay its events over SSE, then see it finished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-http-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      1,
    );
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowPath: ECHO_WORKFLOW, input: {}, dir }),
      });
      expect(startRes.status).toBe(201);
      const { runId } = (await startRes.json()) as { runId: string };
      expect(typeof runId).toBe("string");

      const frames = await readSseUntilTerminal(`${base}/api/runs/${runId}/events`);
      const tags = frames.map((f) => f.tag);
      expect(tags).toContain("RunStarted");
      expect(tags).toContain("RunFinished");

      const getRes = await fetch(`${base}/api/runs/${runId}`);
      expect(getRes.status).toBe(200);
      const run = (await getRes.json()) as { status: string };
      expect(run.status).toBe("RunFinished");

      const listRes = await fetch(`${base}/api/runs`);
      const runs = (await listRes.json()) as ReadonlyArray<{ runId: string }>;
      expect(runs.some((r) => r.runId === runId)).toBe(true);

      const cancelRes = await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
      expect(cancelRes.status).toBe(409);

      const missingRes = await fetch(`${base}/api/runs/does-not-exist`);
      expect(missingRes.status).toBe(404);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cancelling an in-flight run stops it and is reflected in /api/runs/:id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-http-cancel-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      500,
    );
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowPath: ECHO_WORKFLOW, input: {}, dir }),
      });
      const { runId } = (await startRes.json()) as { runId: string };

      await Bun.sleep(50);
      const cancelRes = await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" });
      expect(cancelRes.status).toBe(200);

      const getRes = await fetch(`${base}/api/runs/${runId}`);
      const run = (await getRes.json()) as { status: string };
      expect(run.status).toBe("RunCancelled");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an SSE client that disconnects mid-run does not take the daemon down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-http-sse-abandon-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "one" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "two" },
        { type: "TEXT_MESSAGE_END" },
      ],
      60,
    );
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowPath: ECHO_WORKFLOW, input: {}, dir }),
      });
      const { runId } = (await startRes.json()) as { runId: string };

      // A run-detail page opens the tail and the browser navigates away
      // before the run ends — the fetch is aborted, never drained.
      const response = await fetch(`${base}/api/runs/${runId}/events`);
      response.body!.cancel().catch(() => undefined);

      // The run must keep streaming somewhere real: the db reaches terminal.
      await waitForTerminal(db, runId, 10_000);

      // And the same daemon must still answer requests.
      const after = await fetch(`${base}/api/runs`);
      expect(after.status).toBe(200);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an in-flight run is flagged active; a terminal run is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-http-active-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      400,
    );
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowPath: ECHO_WORKFLOW, input: {}, dir }),
      });
      const { runId } = (await startRes.json()) as { runId: string };

      const listRes = await fetch(`${base}/api/runs`);
      const runs = (await listRes.json()) as ReadonlyArray<{ runId: string; active: boolean }>;
      expect(runs.find((r) => r.runId === runId)?.active).toBe(true);

      await readSseUntilTerminal(`${base}/api/runs/${runId}/events`);

      const getRes = await fetch(`${base}/api/runs/${runId}`);
      const run = (await getRes.json()) as { active: boolean; status: string };
      expect(run.active).toBe(false);
      expect(run.status).toBe("RunFinished");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SSE frames carry id: <seq>, and a Last-Event-ID reconnect resumes past that seq", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-http-resume-test-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      1,
    );
    const server = serve({ db, adapter, port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowPath: ECHO_WORKFLOW, input: {}, dir }),
      });
      const { runId } = (await startRes.json()) as { runId: string };
      const eventsUrl = `${base}/api/runs/${runId}/events`;

      const first = await readSseUntilTerminal(eventsUrl);
      expect(first.length).toBeGreaterThan(2);
      // Every frame is stamped with its own seq.
      for (const frame of first) expect(frame.id).toBe(frame.seq);

      // Reconnect from a seq partway through: exactly the events after it, no
      // replay of the prefix (the whole point of `id:` + Last-Event-ID).
      const resumeFrom = first[1]!.seq;
      const expectedAfter = first.filter((f) => f.seq > resumeFrom).map((f) => f.seq);
      const resumed = await readSseUntilTerminal(eventsUrl, {
        "Last-Event-ID": String(resumeFrom),
      });
      expect(resumed.map((f) => f.seq)).toEqual(expectedAfter);
      expect(resumed.every((f) => f.seq > resumeFrom)).toBe(true);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/runs {workflowId, input} (D31)", () => {
  test("400 on input that fails the workflow's own schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-d31-decode-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      1,
    );
    const config = await loadFactoryConfig(FIXTURE_CONFIG);
    const server = serve({ db, adapter, port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "registry-test", input: { issueNumber: "seven" } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("registry-test");
      expect(body.error).toContain("decode");
      const runs = (await fetch(`${base}/api/runs`).then((r) => r.json())) as Array<unknown>;
      expect(runs).toEqual([]);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("404 on an unknown workflow id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-d31-unknown-"));
    const db = openStore(join(dir, "factory.db"));
    const adapter = createSlowFakeAdapter([], 1);
    const config = await loadFactoryConfig(FIXTURE_CONFIG);
    const server = serve({ db, adapter, port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "no-such-workflow", input: {} }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("no-such-workflow");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("409 over the admission limit (D29), and 201 again once a slot frees", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-d31-limit-"));
    const seed = join(root, "seed-repo");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q --allow-empty -m seed`.quiet();

    const workspaceRoot = join(root, "workspaces");
    const db = openStore(join(root, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      300,
    );
    const config = defineConfig({
      repo: {
        sshUrl: seed,
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [registryWorkflow],
      workspaceRoot,
      maxConcurrentRuns: 1,
      retainedWorkspaces: 10,
    });
    const server = serve({ db, adapter, port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const first = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "registry-test", input: { issueNumber: 1 } }),
      });
      expect(first.status).toBe(201);
      const { runId } = (await first.json()) as { runId: string };

      const second = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "registry-test", input: { issueNumber: 2 } }),
      });
      expect(second.status).toBe(409);

      await waitForTerminal(db, runId, 10_000);

      const third = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "registry-test", input: { issueNumber: 3 } }),
      });
      expect(third.status).toBe(201);
      await waitForTerminal(db, ((await third.json()) as { runId: string }).runId, 10_000);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("success path: run starts in a config-supplied tree and streams over real sqlite", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-d31-success-"));
    const seed = join(root, "seed-repo");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q --allow-empty -m seed`.quiet();

    const workspaceRoot = join(root, "workspaces");
    const db = openStore(join(root, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      1,
    );
    const config = defineConfig({
      repo: {
        sshUrl: seed,
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [registryWorkflow],
      workspaceRoot,
      maxConcurrentRuns: 3,
      retainedWorkspaces: 10,
    });
    const server = serve({ db, adapter, port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "registry-test", input: { issueNumber: 42 } }),
      });
      expect(startRes.status).toBe(201);
      const { runId } = (await startRes.json()) as { runId: string };

      const frames = await readSseUntilTerminal(`${base}/api/runs/${runId}/events`);
      const tags = frames.map((f) => f.tag);
      expect(tags).toContain("RunStarted");
      expect(tags).toContain("RunFinished");

      const dbEvents = getRunEvents(db, runId);
      const started = dbEvents.find((e) => e.payload._tag === "RunStarted") as
        | { payload: { dir: string; input: { issueNumber: number } } }
        | undefined;
      expect(started).toBeDefined();
      expect(started!.payload.dir.startsWith(workspaceRoot)).toBe(true);
      expect(started!.payload.input.issueNumber).toBe(42);

      const run = (await fetch(`${base}/api/runs/${runId}`).then((r) => r.json())) as {
        status: string;
      };
      expect(run.status).toBe("RunFinished");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a scratch workflow through POST /api/runs (issue #13)", () => {
  test("a scratch run needs no mirror or clone: no ssh remote required; dir reaped on success; run detail reports the kind", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-d31-scratch-"));
    // Deliberately not a git repo — a clone workspace would fail mirror
    // refresh at allocation and the run would never start; a scratch run
    // needs no mirror refresh or clone at all.
    const notARepo = join(root, "not-a-repo");
    await Bun.$`mkdir ${notARepo}`.quiet();

    const workspaceRoot = join(root, "workspaces");
    const db = openStore(join(root, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      1,
    );
    const config = defineConfig({
      repo: {
        sshUrl: notARepo,
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [registryScratchWorkflow],
      workspaceRoot,
      maxConcurrentRuns: 3,
      retainedWorkspaces: 10,
    });
    const server = serve({ db, adapter, port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "registry-scratch-test", input: {} }),
      });
      expect(startRes.status).toBe(201);
      const { runId } = (await startRes.json()) as { runId: string };

      // No clone instead of the real one: an erroring mirror refresh must
      // not matter for a scratch run. Point the config away from git entirely
      // by removing the seed — a clone workspace would fail allocation here.
      await waitForTerminal(db, runId, 10_000);

      const events = getRunEvents(db, runId);
      const started = events.find((e) => e.payload._tag === "RunStarted");
      expect(started?.payload).toMatchObject({ workspaceKind: "scratch" });

      // Completed scratch runs are reaped: no dir, no mirror. The reap lands
      // after the terminal event, so poll briefly.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && existsSync(join(workspaceRoot, runId))) {
        await Bun.sleep(25);
      }
      expect(existsSync(join(workspaceRoot, runId))).toBe(false);
      expect(existsSync(join(workspaceRoot, ".mirror.git"))).toBe(false);

      const detail = (await fetch(`${base}/api/runs/${runId}`).then((r) => r.json())) as {
        workspaceKind: string;
      };
      expect(detail.workspaceKind).toBe("scratch");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ctx.dispatch through POST /api/runs (issue #14)", () => {
  test("a registry workflow dispatches a child via the config's dispatch env", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-http-nested-"));
    const db = openStore(join(root, "factory.db"));
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      1,
    );

    const childWorkflow = defineWorkflow("nested-child-http", {
      input: Schema.Struct({ n: Schema.Number }),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        await ctx.exec(["sh", "-c", "true"]);
        return { n: ctx ? 1 : 1 };
      },
    });
    const dispatcherWorkflow = defineWorkflow("dispatcher-http", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        const childRunId = await ctx.dispatch(childWorkflow, { n: 3 });
        return { childRunId };
      },
    });

    const server = serve({
      db,
      adapter,
      port: 0,
      config: defineConfig({
        repo: {
          sshUrl: "git@github.com:acme/widgets.git",
          identity: { name: "Factory", email: "factory@factory.test" },
          baseBranch: "main",
          slug: "acme/widgets",
        },
        workflows: [dispatcherWorkflow, childWorkflow],
        workspaceRoot: join(root, "workspaces"),
        retainedWorkspaces: 10,
      }),
    });
    const base = `http://localhost:${server.port}`;

    try {
      const startRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        body: JSON.stringify({ workflowId: "dispatcher-http", input: {} }),
      });
      expect(startRes.status).toBe(201);
      const { runId: parentRunId } = (await startRes.json()) as { runId: string };

      await waitForTerminal(db, parentRunId, 10_000);

      const parentEvents = getRunEvents(db, parentRunId);
      const dispatched = parentEvents.find((e) => e.payload._tag === "RunDispatched");
      expect(dispatched).toBeDefined();
      const childRunId =
        dispatched !== undefined && dispatched.payload._tag === "RunDispatched"
          ? dispatched.payload.childRunId
          : undefined;
      expect(childRunId).toBeTypeOf("string");
      if (childRunId === undefined) return;

      // Fire-and-forget: the parent's terminal says nothing about the child,
      // so wait for the child's own terminal separately.
      await waitForTerminal(db, childRunId, 10_000);

      const childStarted = getRunEvents(db, childRunId).find(
        (e) => e.payload._tag === "RunStarted",
      );
      expect(
        childStarted !== undefined && childStarted.payload._tag === "RunStarted"
          ? childStarted.payload.parentId
          : "missing",
      ).toBe(parentRunId);
      expect(
        childStarted !== undefined && childStarted.payload._tag === "RunStarted"
          ? childStarted.payload.input
          : "missing",
      ).toEqual({ n: 3 });
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GET /api/schedules (issue #17)", () => {
  function schedulesConfig(
    root: string,
    workflow: WorkflowDefinition<any, any>,
  ): ReturnType<typeof defineConfig> {
    return defineConfig({
      repo: {
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [workflow],
      workspaceRoot: join(root, "workspaces"),
      retainedWorkspaces: 10,
      schedules: [
        {
          id: "nightly-check",
          workflow: workflow.id,
          input: { issueNumber: 5 },
          cron: "30 4 * * *",
          timezone: "Europe/Berlin",
        },
      ],
    });
  }

  test("lists id, workflow, input, cron, timezone, next fire time and no last run yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-schedules-test-"));
    const db = openStore(join(root, "factory.db"));
    const workflow = defineWorkflow("scheduled-list-test", {
      input: Schema.Struct({ issueNumber: Schema.Number }),
      workspace: { kind: "scratch" },
      run: async () => ({}),
    });
    const server = serve({
      db,
      adapter: createSlowFakeAdapter([], 1),
      port: 0,
      config: schedulesConfig(root, workflow),
    });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/schedules`);
      expect(res.status).toBe(200);
      const schedules = (await res.json()) as Array<{
        id: string;
        workflowId: string;
        input: unknown;
        cron: string;
        timezone: string;
        overlap: string;
        runOnStart: boolean;
        nextFireAt: number;
        lastRun: unknown;
      }>;
      expect(schedules).toHaveLength(1);
      const schedule = schedules[0]!;
      expect(schedule.id).toBe("nightly-check");
      expect(schedule.workflowId).toBe(workflow.id);
      expect(schedule.input).toEqual({ issueNumber: 5 });
      expect(schedule.cron).toBe("30 4 * * *");
      expect(schedule.timezone).toBe("Europe/Berlin");
      expect(schedule.overlap).toBe("skip");
      expect(schedule.runOnStart).toBe(false);
      // The next fire is a computable future instant derived from the cron.
      expect(schedule.nextFireAt).toBeGreaterThan(Date.now());
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nextFireAt is computed in the schedule's timezone, not the daemon's", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-schedules-zone-test-"));
    const db = openStore(join(root, "factory.db"));
    const workflow = defineWorkflow("scheduled-zone-test", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async () => ({}),
    });
    // 04:30 Europe/Berlin daily. In January that is 03:30 UTC.
    const config = defineConfig({
      repo: {
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [workflow],
      workspaceRoot: join(root, "workspaces"),
      retainedWorkspaces: 10,
      schedules: [
        {
          id: "berlin-morning",
          workflow: workflow.id,
          input: {},
          cron: "30 4 * * *",
          timezone: "Europe/Berlin",
        },
      ],
    });
    const server = serve({ db, adapter: createSlowFakeAdapter([], 1), port: 0, config });
    const base = `http://localhost:${server.port}`;

    const { Cron } = await import("effect");
    try {
      // Advance now to 2026-01-10T12:00:00Z, just before midnight Berlin.
      const res = await fetch(`${base}/api/schedules`);
      const schedules = (await res.json()) as Array<{ nextFireAt: number }>;
      const { nextFireAt } = schedules[0]!;
      expect(nextFireAt).toBe(Cron.next(Cron.parseUnsafe("30 4 * * *", "Europe/Berlin")).getTime());
      expect(nextFireAt).toBeGreaterThan(Date.now());
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serves an empty list on a legacy no-config server", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-schedules-empty-test-"));
    const db = openStore(join(root, "factory.db"));
    const server = serve({ db, adapter: createSlowFakeAdapter([], 1), port: 0 });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/schedules`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lastRun reports the most recent run that carries the schedule's id", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-schedules-lastrun-test-"));
    const db = openStore(join(root, "factory.db"));
    const workflow = defineWorkflow("scheduled-lastrun-test", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async () => ({}),
    });
    const config = defineConfig({
      repo: {
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [workflow],
      workspaceRoot: join(root, "workspaces"),
      retainedWorkspaces: 10,
      schedules: [
        {
          id: "evening-check",
          workflow: workflow.id,
          input: {},
          cron: "* * * * *",
          timezone: "UTC",
        },
      ],
    });
    const server = serve({ db, adapter: createSlowFakeAdapter([], 1), port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const insertEvent = (
        runId: string,
        seq: number,
        ts: number,
        tag: string,
        payload: unknown,
      ): void => {
        db.query(`INSERT INTO events (run_id, seq, ts, tag, payload) VALUES (?, ?, ?, ?, ?)`).run(
          runId,
          seq,
          ts,
          tag,
          JSON.stringify(payload),
        );
      };
      // Seed a fired run (older) and a later finished run with this scheduleId.
      const older = Date.now() - 10_000;
      const newer = Date.now() - 5_000;
      insertEvent("run-sched-old", 0, older, "RunStarted", {
        _tag: "RunStarted",
        workflowId: workflow.id,
        dir: "somewhere",
        input: {},
        scheduleId: "evening-check",
      });
      insertEvent("run-sched-old", 1, older + 10, "RunFailed", {
        _tag: "RunFailed",
        error: { _tag: "ExecError" },
      });
      insertEvent("run-sched-new", 0, newer, "RunStarted", {
        _tag: "RunStarted",
        workflowId: workflow.id,
        dir: "somewhere",
        input: {},
        scheduleId: "evening-check",
      });
      insertEvent("run-sched-new", 1, newer + 10, "RunFinished", { _tag: "RunFinished" });
      insertEvent("run-unrelated", 0, newer, "RunStarted", {
        _tag: "RunStarted",
        workflowId: workflow.id,
        dir: "somewhere",
        input: {},
      });
      insertEvent("run-unrelated", 1, newer + 10, "RunFinished", { _tag: "RunFinished" });

      const res = await fetch(`${base}/api/schedules`);
      const schedules = (await res.json()) as Array<{
        lastRun: { runId: string; status: string; startedAt: number } | undefined;
      }>;
      const { lastRun } = schedules[0]!;
      expect(lastRun).toMatchObject({ runId: "run-sched-new", status: "RunFinished" });
      expect(lastRun!.startedAt).toBe(newer);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("POST /api/schedules/:id/run (issue #17)", () => {
  test("starts the schedule's workflow with its configured input and the schedule's id", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-schedules-runnow-test-"));
    const db = openStore(join(root, "factory.db"));
    const workflow = defineWorkflow("scheduled-runnow-test", {
      input: Schema.Struct({ issueNumber: Schema.Number }),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        await ctx.exec(["sh", "-c", "true"]);
        return {};
      },
    });
    const config = defineConfig({
      repo: {
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [workflow],
      workspaceRoot: join(root, "workspaces"),
      retainedWorkspaces: 10,
      schedules: [
        {
          id: "nightly-run",
          workflow: workflow.id,
          input: { issueNumber: 12 },
          cron: "0 3 * * *",
          timezone: "UTC",
        },
      ],
    });
    const server = serve({ db, adapter: createSlowFakeAdapter([], 1), port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/schedules/nightly-run/run`, { method: "POST" });
      expect(res.status).toBe(201);
      const { runId } = (await res.json()) as { runId: string };
      await waitForTerminal(db, runId, 10_000);

      const started = getRunEvents(db, runId).find((e) => e.payload._tag === "RunStarted");
      expect(
        started !== undefined && started.payload._tag === "RunStarted"
          ? started.payload.input
          : "missing",
      ).toEqual({ issueNumber: 12 });
      expect(
        started !== undefined && started.payload._tag === "RunStarted"
          ? started.payload.scheduleId
          : "missing",
      ).toBe("nightly-run");
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("404s for an unknown schedule id", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-schedules-404-test-"));
    const db = openStore(join(root, "factory.db"));
    const workflow = defineWorkflow("scheduled-404-test", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async () => ({}),
    });
    const config = defineConfig({
      repo: {
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [workflow],
      workspaceRoot: join(root, "workspaces"),
      retainedWorkspaces: 10,
      schedules: [
        { id: "nightly-run", workflow: workflow.id, input: {}, cron: "0 3 * * *", timezone: "UTC" },
      ],
    });
    const server = serve({ db, adapter: createSlowFakeAdapter([], 1), port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const res = await fetch(`${base}/api/schedules/nope/run`, { method: "POST" });
      expect(res.status).toBe(404);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a manual trigger under overlap 'skip' surfaces a collision as a 409, naming the holder", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-schedules-collision-test-"));
    const db = openStore(join(root, "factory.db"));
    const workflow = defineWorkflow("scheduled-slow-test", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        await ctx.exec(["sh", "-c", "sleep 0.5"]);
        return {};
      },
    });
    const config = defineConfig({
      repo: {
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [workflow],
      workspaceRoot: join(root, "workspaces"),
      retainedWorkspaces: 10,
      schedules: [
        { id: "slow-skip", workflow: workflow.id, input: {}, cron: "0 3 * * *", timezone: "UTC" },
      ],
    });
    const server = serve({ db, adapter: createSlowFakeAdapter([], 1), port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const first = await fetch(`${base}/api/schedules/slow-skip/run`, { method: "POST" });
      expect(first.status).toBe(201);
      const { runId: holderRunId } = (await first.json()) as { runId: string };

      const second = await fetch(`${base}/api/schedules/slow-skip/run`, { method: "POST" });
      expect(second.status).toBe(409);
      const collision = (await second.json()) as {
        error: string;
        dedupeKey: string;
        holderRunId: string;
      };
      expect(collision.dedupeKey).toBe("schedule:slow-skip");
      expect(collision.holderRunId).toBe(holderRunId);
      expect(collision.error).toContain("schedule:slow-skip");
      expect(collision.error).toContain(holderRunId);

      await waitForTerminal(db, holderRunId, 10_000);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a manual trigger under overlap 'stack' fires even while another run holds the key", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-schedules-stack-test-"));
    const db = openStore(join(root, "factory.db"));
    const workflow = defineWorkflow("scheduled-stack-test", {
      input: Schema.Struct({}),
      workspace: { kind: "scratch" },
      run: async (ctx) => {
        await ctx.exec(["sh", "-c", "sleep 0.5"]);
        return {};
      },
    });
    const config = defineConfig({
      repo: {
        sshUrl: join(root, "seed-not-used"),
        identity: { name: "Factory", email: "factory@factory.test" },
        baseBranch: "main",
        slug: "acme/widgets",
      },
      workflows: [workflow],
      workspaceRoot: join(root, "workspaces"),
      retainedWorkspaces: 10,
      schedules: [
        {
          id: "slow-stack",
          workflow: workflow.id,
          input: {},
          cron: "0 3 * * *",
          timezone: "UTC",
          overlap: "stack",
        },
      ],
    });
    const server = serve({ db, adapter: createSlowFakeAdapter([], 1), port: 0, config });
    const base = `http://localhost:${server.port}`;

    try {
      const first = await fetch(`${base}/api/schedules/slow-stack/run`, { method: "POST" });
      expect(first.status).toBe(201);
      const { runId: firstRunId } = (await first.json()) as { runId: string };

      const second = await fetch(`${base}/api/schedules/slow-stack/run`, { method: "POST" });
      expect(second.status).toBe(201);
      const { runId: secondRunId } = (await second.json()) as { runId: string };
      expect(secondRunId).not.toBe(firstRunId);

      await waitForTerminal(db, firstRunId, 10_000);
      await waitForTerminal(db, secondRunId, 10_000);
    } finally {
      await server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
