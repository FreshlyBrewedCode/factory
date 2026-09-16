/**
 * The SSE client both consumers of `GET /api/runs/:id/events` read through:
 * the SPA's run-detail page (`web/api.ts`) and `factory start --watch`
 * (`cli.ts`). One module because the interesting part is a *retry policy*, and
 * two copies of a retry policy drift — the CLI already had its own, with a
 * budget that never reset, while the SPA had none at all.
 *
 * Reconnecting is not an optimisation. A tail's connection can drop while the
 * run behind it is perfectly healthy: `Bun.serve` closes an idle one after 10s
 * (which is why the server sends keepalives, `server/http.ts`), a laptop
 * sleeps, a network blips. Treating that as "the run ended" is what made the
 * SPA render live runs as `interrupted` and what killed `--watch` mid-run.
 *
 * Resuming is cheap and idempotent: every event is durable in the log, and
 * `Last-Event-ID` is an offset the server already honours (`parseLastEventId`),
 * so a reconnect continues rather than replaying.
 */

import type { RunEvent } from "../events";

export interface SseClientOptions {
  /** Resume offset; sent as `Last-Event-ID` so the server replays from `seq + 1`. */
  readonly sinceSeq?: number;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: RunEvent) => void;
  /**
   * A frame whose `data:` payload would not parse. Skipped either way; this is
   * the hook for reporting it. Deliberately not fatal — one bad frame should
   * not end a tail, and it must not be mistaken for a transport failure and
   * trigger a reconnect.
   */
  readonly onMalformedFrame?: (raw: string) => void;
  /**
   * Consecutive attempts that received *nothing at all* before giving up.
   * Any connection that carries bytes resets it.
   */
  readonly maxReconnects?: number;
  readonly reconnectDelayMs?: number;
  /** Called before each retry sleep, for an operator-facing note. */
  readonly onReconnect?: (attempt: number, max: number) => void;
}

export const DEFAULT_MAX_RECONNECTS = 5;
export const DEFAULT_RECONNECT_DELAY_MS = 1_000;

function dataLine(frame: string): string | undefined {
  for (const line of frame.split("\n")) {
    // A `:`-prefixed comment frame (the server's keepalive) has no `data:`
    // line and is skipped here, which is exactly what SSE intends.
    if (line.startsWith("data:")) return line.slice("data:".length).trimStart();
  }
  return undefined;
}

/** Outcome of a single connection: did it end cleanly, and did it carry bytes? */
interface AttemptResult {
  readonly closedCleanly: boolean;
  readonly receivedBytes: boolean;
}

async function readOnce(
  url: string,
  sinceSeq: number | undefined,
  options: SseClientOptions,
  onSeq: (seq: number) => void,
): Promise<AttemptResult> {
  const headers: Record<string, string> = {};
  if (sinceSeq !== undefined) headers["Last-Event-ID"] = String(sinceSeq);

  const res = await fetch(url, { headers, signal: options.signal });
  if (!res.ok || res.body === null) {
    throw new Error(`GET ${url} returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { closedCleanly: true, receivedBytes };
      if (value !== undefined && value.length > 0) receivedBytes = true;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = dataLine(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (raw !== undefined) {
          let event: RunEvent;
          try {
            event = JSON.parse(raw) as RunEvent;
          } catch {
            options.onMalformedFrame?.(raw);
            boundary = buffer.indexOf("\n\n");
            continue;
          }
          onSeq(event.seq);
          options.onEvent(event);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    // The read threw part-way. Whether that is worth retrying is the caller's
    // call, and it needs to know if this attempt got anywhere first.
    if (receivedBytes) return { closedCleanly: false, receivedBytes };
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Replay-then-tail an SSE endpoint, reconnecting from the last seq seen.
 *
 * Resolves when the server closes cleanly — a terminal event, or a run this
 * process does not hold — and when the caller aborts, since an abort is a
 * decision rather than a failure. Rejects only when the reconnect budget is
 * spent.
 *
 * The budget counts *consecutive* attempts that received nothing at all. Any
 * connection that carries bytes — an event, or just the server's keepalive —
 * is progress and resets it, so a long run over a flaky link is tolerated
 * while a genuinely unreachable server still gives up promptly.
 */
export async function streamSse(url: string, options: SseClientOptions): Promise<void> {
  const maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const delayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let sinceSeq = options.sinceSeq;
  let failures = 0;

  for (;;) {
    let result: AttemptResult;
    try {
      result = await readOnce(url, sinceSeq, options, (seq) => {
        sinceSeq = seq;
      });
    } catch (err) {
      if (options.signal?.aborted === true) throw err;
      failures += 1;
      if (failures > maxReconnects) throw err;
      options.onReconnect?.(failures, maxReconnects);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    if (result.closedCleanly) return;
    if (options.signal?.aborted === true) return;
    if (result.receivedBytes) failures = 0;
    options.onReconnect?.(failures + 1, maxReconnects);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
