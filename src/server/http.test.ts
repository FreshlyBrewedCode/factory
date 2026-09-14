import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createSlowFakeAdapter } from "../replay/adapter";
import { openStore } from "../persistence/store";
import { serve } from "./http";

const ECHO_WORKFLOW = `${import.meta.dir}/../../test/fixtures/echo-workflow.ts`;

async function readSseUntilTerminal(
  url: string,
): Promise<ReadonlyArray<{ payload: { _tag: string } }>> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ payload: { _tag: string } }> = [];
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);

    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.startsWith("data: ")) {
        const event = JSON.parse(frame.slice("data: ".length)) as { payload: { _tag: string } };
        events.push(event);
        if (["RunFinished", "RunFailed", "RunCancelled"].includes(event.payload._tag)) {
          reader.releaseLock();
          return events;
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  return events;
}

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

      const events = await readSseUntilTerminal(`${base}/api/runs/${runId}/events`);
      const tags = events.map((e) => e.payload._tag);
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
});
