import type { RunEvent } from "../events";
import { streamSse, type SseClientOptions } from "../lib/sse-client";
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

export interface WorkflowSummary {
  readonly id: string;
  readonly inputSchema: unknown;
}

export async function fetchWorkflows(): Promise<ReadonlyArray<WorkflowSummary>> {
  const res = await fetch("/api/workflows");
  if (!res.ok) throw new Error(`GET /api/workflows returned ${res.status}`);
  return (await res.json()) as ReadonlyArray<WorkflowSummary>;
}

/**
 * The API's error surface for a start/cancel that the *server* refused —
 * distinct from a transport failure, because the body carries the operator
 * hint (404's `see GET /api/workflows`, 400's schema message, 409's limit).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function errorFrom(res: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Non-JSON error body — keep the fallback.
  }
  return new ApiError(res.status, message);
}

export async function startRun(body: { workflowId: string; input: unknown }): Promise<string> {
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 400 || res.status === 404 || res.status === 409) {
    throw await errorFrom(res, `POST /api/runs returned ${res.status}`);
  }
  if (!res.ok) throw new Error(`POST /api/runs returned ${res.status}`);
  const { runId } = (await res.json()) as { runId: string };
  return runId;
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  if (!res.ok) throw await errorFrom(res, `POST /api/runs/${runId}/cancel returned ${res.status}`);
}

export type SubscribeToRunOptions = SseClientOptions;

/** `streamSse` bound to one run's route — the seam D26 named. */
export function subscribeToRun(runId: string, options: SubscribeToRunOptions): Promise<void> {
  return streamSse(`/api/runs/${encodeURIComponent(runId)}/events`, options);
}
