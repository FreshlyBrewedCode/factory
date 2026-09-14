import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createSlowFakeAdapter } from "../replay/adapter";
import { openStore } from "../persistence/store";
import { serve } from "./http";

const ECHO_WORKFLOW = `${import.meta.dir}/../../test/fixtures/echo-workflow.ts`;

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
