const EM_DASH = "—";

/**
 * `12345` -> `12s`, `95000` -> `1m 35s`, `3723000` -> `1h 02m 03s`. Undefined
 * (no recorded duration) -> em dash.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return EM_DASH;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
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

/** `3648` -> `3.6k`, `10_000` -> `10k`, `1_500_000` -> `1.5m`, `999` -> `999`. */
export function formatTokenCount(n: number): string {
  const trimmed = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${trimmed(n / 1_000)}k`;
  return `${trimmed(n / 1_000_000)}m`;
}

/** Relative label for a future instant — the sibling of `formatAgo`. */
export function formatAhead(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((ts - now) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

/**
 * An agent-reported cost: `$0.039`, `$1.24`, `0.25 EUR`. Small amounts keep
 * enough digits to tell steps apart (`$0.0004`); zero, which opencode reports
 * for a free model, reads `$0`.
 */
export function formatCost(cost: { readonly amount: number; readonly currency: string }): string {
  const { amount, currency } = cost;
  const digits = amount === 0 ? 0 : amount >= 1 ? 2 : amount >= 0.01 ? 3 : 4;
  const figure = amount.toFixed(digits);
  return currency === "USD" ? `$${figure}` : `${figure} ${currency}`;
}

/**
 * Context in use against the window: `15.3k / 200k · 8%`. Without a window
 * (a log from before ACP) just the figure.
 */
export function formatContext(context: {
  readonly used: number;
  readonly size: number | undefined;
}): string {
  if (context.size === undefined || context.size <= 0) return formatTokenCount(context.used);
  const percent = Math.round((context.used / context.size) * 100);
  return `${formatTokenCount(context.used)} / ${formatTokenCount(context.size)} · ${percent}%`;
}
