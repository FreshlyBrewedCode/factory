import { Link } from "@tanstack/react-router";
import { useRuns, useTickingNow } from "@/web/hooks";
import type { RunSummary } from "@/web/api";
import { formatAgo, formatClock, formatDuration, shortRunId } from "@/web/lib/format";
import { runDisplayStatus, type RunDisplayStatus } from "@/web/lib/status";
import { StatusCell } from "@/web/components/status-cell";

function resultLabel(run: RunSummary, status: RunDisplayStatus): string {
  if (status === "running") return "streaming";
  if (status === "interrupted") return "no terminal event";
  if (status === "cancelled") return "stopped mid-stream";
  if (status === "failed") return "failed";
  return `${run.eventCount} events`;
}

function RunRow({ run, now }: { readonly run: RunSummary; readonly now: number }) {
  const status = runDisplayStatus(run);
  const duration =
    run.active || run.finishedAt === undefined
      ? formatDuration(run.active ? now - run.startedAt : undefined)
      : formatDuration(run.finishedAt - run.startedAt);

  return (
    <tr
      data-testid={`run-row-${run.runId}`}
      data-status={status}
      className="cursor-pointer border-b border-border hover:bg-muted/40"
    >
      <td className="px-3 py-2">
        <StatusCell status={status} />
      </td>
      <td className="px-3 py-2">
        <Link
          to="/runs/$runId"
          params={{ runId: run.runId }}
          className="font-mono text-xs font-medium hover:underline"
        >
          {shortRunId(run.runId)}
        </Link>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{run.workflowId ?? "—"}</td>
      <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
        {formatClock(run.startedAt)}
        <span className="ml-2">{formatAgo(run.startedAt, now)}</span>
      </td>
      <td data-testid="run-duration" className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
        {duration}
      </td>
      <td className="px-3 py-2 font-mono text-[11px]" data-testid="run-result">
        {resultLabel(run, status)}
      </td>
    </tr>
  );
}

function RunTable({
  runs,
  now,
}: {
  readonly runs: ReadonlyArray<RunSummary>;
  readonly now: number;
}) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-border text-left">
          {["Status", "Run", "Workflow", "Started", "Duration", "Result"].map((heading) => (
            <th
              key={heading}
              className="px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <RunRow key={run.runId} run={run} now={now} />
        ))}
      </tbody>
    </table>
  );
}

/**
 * Finding 7's chronological runs table: live runs in their own group at the
 * top (pulsing dot, ticking duration), terminal runs below, newest first.
 * Newest-first is S1's `listRuns` ordering; the `active` bit comes from the
 * serving process, because the log cannot tell interrupted from running.
 */
export function RunsPage() {
  const { data, isPending, error } = useRuns();
  const runs = data ?? [];
  const running = runs.filter((run) => run.active);
  const terminal = runs.filter((run) => !run.active);
  const now = useTickingNow(running.length > 0);

  return (
    <section data-testid="runs-page" className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold">Runs</h1>
        <span className="font-mono text-[11px] text-muted-foreground">
          {isPending ? "loading…" : error ? "unavailable" : `${runs.length} recorded`}
        </span>
      </header>

      {error ? (
        <p className="text-sm text-muted-foreground">Could not reach the runs API.</p>
      ) : runs.length === 0 && !isPending ? (
        <p data-testid="runs-empty" className="py-16 text-center text-sm text-muted-foreground">
          No runs recorded yet.
        </p>
      ) : (
        <>
          {running.length > 0 ? (
            <section data-testid="runs-group-running" className="mb-8">
              <div className="mb-2 flex items-center gap-2">
                <i className="status-dot status-pulse" data-status="running" aria-hidden="true" />
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Running
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {running.length}
                </span>
              </div>
              <RunTable runs={running} now={now} />
            </section>
          ) : null}

          <section data-testid="runs-group-recent">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Recent
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">{terminal.length}</span>
            </div>
            <RunTable runs={terminal} now={now} />
          </section>
        </>
      )}
    </section>
  );
}
