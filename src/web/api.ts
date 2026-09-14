import type { RunSummary } from "../persistence/store";

export type { RunSummary };

/**
 * The SPA is served by the same `Bun.serve` as the API (D6), so requests are
 * same-origin and CORS is structurally impossible. This module is the single
 * client-side seam onto the HTTP surface — S3's runs pages consume it, S4's
 * transcript adds `subscribeToRun` beside it (D26).
 */
export async function fetchRuns(): Promise<ReadonlyArray<RunSummary>> {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(`GET /api/runs returned ${res.status}`);
  return (await res.json()) as ReadonlyArray<RunSummary>;
}
