import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AlertTriangle, Play } from "lucide-react";
import type { ScheduleSummary } from "@/web/api";
import { useRunScheduleNow, useSchedules, useTickingNow } from "@/web/hooks";
import { formatAhead, formatInZone } from "@/web/lib/format";
import { statusLabel, type RunDisplayStatus } from "@/web/lib/status";
import { Button } from "@/web/components/ui/button";

/**
 * The schedules page (issue #17): what the daemon is actually configured to
 * run, when each schedule fires next — absolute in the schedule's own
 * timezone and relative to now — how its last run went, and a manual
 * "Run now" that starts the workflow with the configured input and jumps to
 * it. Schedules are read-only here; changing one means editing the config and
 * restarting the daemon.
 */

/** Maps the store's last-run status to the display vocabulary (no `active` bit here). */
function outcome(status: string | undefined): RunDisplayStatus {
  switch (status) {
    case "RunFinished":
      return "finished";
    case "RunFailed":
      return "failed";
    case "RunCancelled":
      return "cancelled";
    default:
      return "interrupted";
  }
}

function ScheduleRow({
  schedule,
  now,
}: {
  readonly schedule: ScheduleSummary;
  readonly now: number;
}) {
  const navigate = useNavigate();
  const runNow = useRunScheduleNow();
  // A collision or other refusal is visible on the row it happened on (issue
  // #17: "a visible error rather than doing nothing"), and clears on the next
  // attempt.
  const [error, setError] = useState<string | undefined>(undefined);

  const start = (): void => {
    setError(undefined);
    runNow.mutate(schedule.id, {
      onSuccess: (runId) => {
        void navigate({ to: "/runs/$runId", params: { runId } });
      },
      onError: (err) => setError(err instanceof Error ? err.message : String(err)),
    });
  };

  return (
    <tr
      data-testid={`schedule-row-${schedule.id}`}
      className="border-b border-border"
      aria-label={`schedule ${schedule.id}`}
    >
      <td className="px-3 py-2">
        <span className="block font-mono text-xs font-medium">{schedule.id}</span>
        <span className="block font-mono text-[11px] text-muted-foreground">
          {schedule.cron} · {schedule.timezone}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {schedule.workflowId}
      </td>
      <td data-testid={`schedule-next-${schedule.id}`} className="px-3 py-2 whitespace-nowrap">
        <span className="block font-mono text-xs">
          {formatInZone(schedule.nextFireAt, schedule.timezone)}
        </span>
        <span className="block font-mono text-[11px] text-muted-foreground">
          {formatAhead(schedule.nextFireAt, now)}
        </span>
      </td>
      <td data-testid={`schedule-last-${schedule.id}`} className="px-3 py-2 whitespace-nowrap">
        {schedule.lastRun === undefined ? (
          <span className="text-muted-foreground">never fired</span>
        ) : (
          <Link
            to="/runs/$runId"
            params={{ runId: schedule.lastRun.runId }}
            className="font-mono text-xs font-medium hover:underline"
          >
            {statusLabel(outcome(schedule.lastRun.status))} ·
            <span className="ml-1 text-muted-foreground">{schedule.lastRun.runId}</span>
          </Link>
        )}
      </td>
      <td className="w-px px-3 py-2 text-right">
        <span className="flex flex-col items-end gap-1">
          <Button
            data-testid={`schedule-run-now-${schedule.id}`}
            size="sm"
            variant="outline"
            className="font-mono text-[11px]"
            disabled={runNow.isPending}
            onClick={start}
          >
            <Play />
            Run now
          </Button>
          {runNow.isError ? (
            <p
              data-testid={`schedule-error-${schedule.id}`}
              className="flex items-center gap-1.5 max-w-64 text-right font-mono text-[11px] text-(--status)"
              data-status="failed"
            >
              <AlertTriangle className="size-3 shrink-0" />
              {error}
            </p>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

/**
 * Finding 7's table language, applied to the config: chronological columns
 * replaced by the schedule's own clock.
 */
export function SchedulesPage() {
  const { data, isPending, error } = useSchedules();
  const schedules = data ?? [];
  const now = useTickingNow(true, 30_000);

  return (
    <section data-testid="schedules-page" className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold">Schedules</h1>
        <span className="font-mono text-[11px] text-muted-foreground">
          {isPending ? "loading…" : error ? "unavailable" : `${schedules.length} configured`}
        </span>
      </header>

      {error ? (
        <p className="text-sm text-muted-foreground">Could not reach the schedules API.</p>
      ) : schedules.length === 0 && !isPending ? (
        <p
          data-testid="schedules-empty"
          className="py-16 text-center text-sm text-muted-foreground"
        >
          No schedules configured.
        </p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-border-strong text-left">
                {["Schedule", "Workflow", "Next fire", "Last run", ""].map((heading) => (
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
              {schedules.map((schedule) => (
                <ScheduleRow key={schedule.id} schedule={schedule} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
