import type { RunEvent } from "../events";
import type { RunSummary as StoredRunSummary } from "../persistence/store";

/** `RunSummary` as the API now serves it: the store's fields plus the live bit. */
export type RunSummary = StoredRunSummary & { readonly active: boolean };
export type { RunEvent };

/**
 * The SPA is served by the same `Bun.serve` as the API (D6), so requests are
 * same-origin and CORS is structurally impossible. This module is the single
 * client-side seam onto the HTTP surface — the runs list, run detail and
 * steps list consume it. `subscribeToRun` is the one transport seam D26
 * asked for, so swapping SSE for a multiplexed socket later is one file.
 */
export async function fetchRuns(): Promise<ReadonlyArray<RunSummary>> {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(`GET /api/runs returned ${res.status}`);
  return (await res.json()) as ReadonlyArray<RunSummary>;
}

export async function fetchRun(runId: string): Promise<RunSummary | undefined> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET /api/runs/${runId} returned ${res.status}`);
  return (await res.json()) as RunSummary;
}

export interface SubscribeToRunOptions {
  /** Resume offset; sent as `Last-Event-ID` so the server replays from `seq + 1`. */
  readonly sinceSeq?: number;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: RunEvent) => void;
}

function dataLine(frame: string): string | undefined {
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) return line.slice("data:".length).trimStart();
  }
  return undefined;
}

/**
 * Replay-then-tail one run's event stream. Resolves when the server closes
 * (terminal event, or a run this process does not hold), rejects only on a
 * transport error — an aborted read is caught by the caller.
 */
export async function subscribeToRun(runId: string, options: SubscribeToRunOptions): Promise<void> {
  const headers: Record<string, string> = {};
  if (options.sinceSeq !== undefined) headers["Last-Event-ID"] = String(options.sinceSeq);

  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events`, {
    headers,
    signal: options.signal,
  });
  if (!res.ok || res.body === null) {
    throw new Error(`GET /api/runs/${runId}/events returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = dataLine(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (raw !== undefined) options.onEvent(JSON.parse(raw) as RunEvent);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
