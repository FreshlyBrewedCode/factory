import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RunEvent } from "../events";
import { cancelRun, fetchRun, fetchRuns, fetchWorkflows, startRun, subscribeToRun } from "./api";

/** The runs list; polls cheaply (S1 made summaries SQL aggregates) so new runs appear. */
export function useRuns() {
  return useQuery({ queryKey: ["runs"], queryFn: fetchRuns, refetchInterval: 2_000 });
}

/**
 * One run's summary. Polled while the server still holds the run, because its
 * `active` bit is what tells a live run apart from a crashed one when the SSE
 * stream is down (`runDetailStatus`) — a value fetched once at mount cannot do
 * that job. Polling stops as soon as the server reports the run inactive: from
 * that point the summary is final.
 */
export function useRun(runId: string) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchRun(runId),
    refetchInterval: (query) => (query.state.data?.active === false ? false : 2_000),
  });
}

/** The workflow registry (D30), for the New-run dialog. */
export function useWorkflows() {
  return useQuery({ queryKey: ["workflows"], queryFn: fetchWorkflows });
}

/** Starts a run via D31's `{workflowId, input}` and refreshes the runs list. */
export function useStartRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startRun,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

/** Cancels a live run via the phase 3 cancel endpoint and refreshes what reads it. */
export function useCancelRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => cancelRun(runId),
    onSuccess: (_result, runId) => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
    },
  });
}

export interface RunEventsState {
  readonly events: ReadonlyArray<RunEvent>;
  /**
   * The SSE connection is open. **Not** the same as "the run is live": since
   * `subscribeToRun` reconnects, this settles false only when the stream ends
   * for good — a clean close, or the reconnect budget running out. Whether the
   * *run* is live is `runDetailStatus`'s question, and it needs the server's
   * `active` bit too.
   */
  readonly streaming: boolean;
}

/**
 * Replay-then-tail a run's event log over SSE (D26). Events are appended in
 * `seq` order and de-duplicated, because a reconnect replays from an offset
 * and the live tail races the persisted read.
 *
 * Callers must remount per `runId` (e.g. `<View key={runId} />`): state is
 * reset by remount, not by an effect that synchronously clears it.
 */
export function useRunEvents(runId: string): RunEventsState {
  const [events, setEvents] = useState<ReadonlyArray<RunEvent>>([]);
  // Optimistically live: a running run must not flash "interrupted" before the
  // stream opens. A terminal run's stream closes after its (fast) replay.
  const [streaming, setStreaming] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    subscribeToRun(runId, {
      signal: controller.signal,
      onEvent: (event) => {
        if (disposed) return;
        setEvents((previous) =>
          previous.some((known) => known.seq === event.seq) ? previous : [...previous, event],
        );
      },
    })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setStreaming(false);
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [runId]);

  return { events, streaming };
}

/** A clock that ticks once a second while `enabled`, for live durations. */
export function useTickingNow(enabled: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
