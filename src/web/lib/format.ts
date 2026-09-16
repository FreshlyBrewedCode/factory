const EM_DASH = "—";

/** `12345` -> `12s`, `95000` -> `1m 35s`. Undefined (no recorded duration) -> em dash. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return EM_DASH;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** `HH:MM:SS` in local time — an instrument-panel clock, not a locale string. */
export function formatClock(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Relative label for a start/finish stamp. `now` is injectable for tests. */
export function formatAgo(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

/** A compact, stable run handle for dense tables. Full id stays on the detail page. */
export function shortRunId(runId: string): string {
  return runId.startsWith("run-") ? `…${runId.slice(-8)}` : runId;
}

/**
 * An absolute stamp rendered in the timezone named — the schedules page shows
 * a cron's next fire the way the schedule will actually observe it (issue
 * #17), never the viewing machine's zone. `Intl` throws for a bad zone; the
 * config load already validated every timezone, so clients can treat this as
 * a server contract.
 */
export function formatInZone(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

/** Relative label for a future instant — the sibling of `formatAgo`. */
export function formatAhead(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((ts - now) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours}h ${minutes % 60}m`;
}
