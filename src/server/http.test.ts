import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createSlowFakeAdapter } from "../replay/adapter";
import { getRunEvents, openStore } from "../persistence/store";
import { defineConfig, loadFactoryConfig } from "../config";
import registryWorkflow from "../../test/fixtures/registry-workflow";
import { serve } from "./http";

const ECHO_WORKFLOW = `${import.meta.dir}/../../test/fixtures/echo-workflow.ts`;
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
