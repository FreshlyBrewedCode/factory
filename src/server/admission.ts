/**
 * D29's single admission function (ADR 0005): the one place
 * `maxConcurrentRuns` is enforced, shared by the HTTP start path
 * (`POST /api/runs` → 409 over the limit) and the dispatcher (skip the
 * pass). Deliberately a pure function over the limit and the live count so
 * the queued-runs scheduler later swaps in here rather than a redesign.
 */

export function admitRun(maxConcurrentRuns: number, activeRunCount: number): boolean {
  return activeRunCount < maxConcurrentRuns;
}
