import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../events";
import { streamSse } from "./sse-client";

/**
 * The SPA's SSE transport, tested against a real `Bun.serve` rather than a
 * stubbed `fetch`: the behaviour under test *is* transport behaviour (a socket
 * dropping mid-stream, a `Last-Event-ID` resume), so a fake transport could
 * only assert that we call it the way we call it.
 *
 * `controller.error()` is how a drop is induced. It surfaces to the client as
 * the same `TypeError: The socket connection was closed unexpectedly` that
 * `Bun.serve`'s 10s `idleTimeout` produces against a quiet live run — the
 * failure this whole change exists to survive — without the 10s wait.
 */

function frame(seq: number): string {
  const event = { runId: "run-test", seq, ts: 1_000 + seq, payload: { _tag: "LogRecorded" } };
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

interface FakeSse {
  readonly url: string;
  /** One entry per connection, in order: the `Last-Event-ID` it arrived with. */
  readonly resumeOffsets: ReadonlyArray<string | null>;
  stop: () => void;
}

/**
 * An SSE endpoint scripted per connection. Each element of `script` handles one
 * connection: it gets the sequence numbers to send, and whether to end by
 * dropping the socket or closing cleanly. Connections past the end of the
 * script drop immediately, sending nothing.
 */
function fakeSseServer(
  script: ReadonlyArray<{ send: ReadonlyArray<number>; then: "drop" | "close" }>,
): FakeSse {
  const resumeOffsets: Array<string | null> = [];
  const encoder = new TextEncoder();

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const attempt = resumeOffsets.length;
      resumeOffsets.push(req.headers.get("last-event-id"));
      const step = script[attempt];

      return new Response(
        new ReadableStream({
          start(controller) {
            if (step === undefined) {
              controller.error();
              return;
            }
            for (const seq of step.send) controller.enqueue(encoder.encode(frame(seq)));
            if (step.then === "close") controller.close();
            else setTimeout(() => controller.error(), 10);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  return {
    url: `http://localhost:${server.port}/events`,
    resumeOffsets,
    stop: () => void server.stop(true),
  };
}

describe("streamSse reconnect", () => {
  test("resumes from the last seq it saw when the connection drops", async () => {
    const server = fakeSseServer([
      { send: [0, 1], then: "drop" },
      { send: [2, 3], then: "close" },
    ]);
    const seen: Array<number> = [];

    try {
      await streamSse(server.url, {
        onEvent: (event: RunEvent) => void seen.push(event.seq),
        reconnectDelayMs: 1,
      });

      // Every event arrives exactly once, in order, across the drop.
      expect(seen).toEqual([0, 1, 2, 3]);
      // The resume is the point of it: the second connection asks the server to
      // pick up after seq 1 rather than replaying from the start.
      expect(server.resumeOffsets).toEqual([null, "1"]);
    } finally {
      server.stop();
    }
  });

  test("gives up once the reconnect budget of dead attempts is spent", async () => {
    // An empty script: every connection drops having sent nothing, which is
    // what an unreachable or broken daemon looks like.
    const server = fakeSseServer([]);

    try {
      const attempt = streamSse(server.url, {
        onEvent: () => undefined,
        maxReconnects: 2,
        reconnectDelayMs: 1,
      });
      await expect(attempt).rejects.toThrow();
      // The first try plus two reconnects — it stops rather than looping.
      expect(server.resumeOffsets).toHaveLength(3);
    } finally {
      server.stop();
    }
  });

  test("a connection that delivered bytes refills the budget", async () => {
    /*
     * Dead attempts *interleaved* with productive ones, against a budget of
     * one. Three dead attempts total is over budget if the counter only ever
     * climbs; it completes only if each productive attempt resets it. A long
     * run on a flaky link is the real case, and it is the shape the CLI's
     * equivalent bug had — `watchSse`'s counter never reset either.
     *
     * Interleaving is load-bearing: a run of consecutive productive attempts
     * would pass either way, because a productive attempt never increments the
     * counter to begin with.
     */
    const server = fakeSseServer([
      { send: [], then: "drop" },
      { send: [0], then: "drop" },
      { send: [], then: "drop" },
      { send: [1], then: "drop" },
      { send: [], then: "drop" },
      { send: [2], then: "close" },
    ]);
    const seen: Array<number> = [];

    try {
      await streamSse(server.url, {
        onEvent: (event: RunEvent) => void seen.push(event.seq),
        maxReconnects: 1,
        reconnectDelayMs: 1,
      });
      expect(seen).toEqual([0, 1, 2]);
      expect(server.resumeOffsets).toHaveLength(6);
    } finally {
      server.stop();
    }
  });

  test("an aborted subscription ends quietly instead of reconnecting", async () => {
    /*
     * What unmounting the run-detail page does. An abort is a caller decision,
     * not a failure, so it must settle as one: the subscription resolves, no
     * further connection is opened, and no retry delay is served first.
     *
     * Asserting the connection count alone would not discriminate — `fetch`
     * rejects an already-aborted signal without reaching the server — so the
     * resolve/reject distinction is the assertion that has teeth.
     */
    const server = fakeSseServer([
      { send: [0], then: "drop" },
      { send: [1], then: "close" },
    ]);
    const controller = new AbortController();

    try {
      const attempt = streamSse(server.url, {
        signal: controller.signal,
        onEvent: () => controller.abort(),
        reconnectDelayMs: 1,
      });
      await expect(attempt).resolves.toBeUndefined();
      expect(server.resumeOffsets).toHaveLength(1);
    } finally {
      server.stop();
    }
  });
});
