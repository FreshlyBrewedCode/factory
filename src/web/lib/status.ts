import type { RunSummary } from "../api";

/**
 * The status visual language is shared between the runs page and the steps
 * list (finding 7): one dot + uppercase mono label, colour meaning *only*
 * status. `data-status` carries the semantic value; `styles.css` maps it to a
 * token, so the same vocabulary tints both surfaces.
 */

export type RunDisplayStatus = "running" | "finished" | "failed" | "cancelled" | "interrupted";

export type StepDisplayStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "pass"
  | "fail"
  | "pending"
  | "neutral";

export type DisplayStatus = RunDisplayStatus | StepDisplayStatus;

/** `RunSummary.active` wins over the store's terminal-or-absent status. */
export function runDisplayStatus(run: Pick<RunSummary, "active" | "status">): RunDisplayStatus {
  if (run.active) return "running";
  switch (run.status) {
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

export interface RunDetailStatusInput {
  /** From the run's own events — the terminal event, if this page has seen it. */
  readonly terminalTag: "RunFinished" | "RunFailed" | "RunCancelled" | undefined;
  /** Is the SSE connection open? */
  readonly streaming: boolean;
  /** The polled run summary, if it has loaded. */
  readonly summary: Pick<RunSummary, "active" | "status"> | undefined;
}

/**
 * The run-detail badge, from all three sources that know anything.
 *
 * The ordering is the point. A terminal event outranks everything: it is the
 * spine (D3), and a page holding one is not guessing. Otherwise the run is
 * live if *either* the stream is open or the server still holds it — and the
 * `or` is what fixes the defect this projection was extracted for. The page
 * used to equate "stream closed" with "run over" and pass a hardcoded
 * `active: false` down, so one dropped SSE connection under a healthy run
 * rendered it "interrupted" (the store derives that for any run without a
 * terminal event, `persistence/store.ts`) until someone refreshed.
 *
 * `interrupted` is left meaning what D12 and D21 made it mean: no terminal
 * event was ever written *and* no process holds the run.
 */
export function runDetailStatus(input: RunDetailStatusInput): RunDisplayStatus {
  switch (input.terminalTag) {
    case "RunFinished":
      return "finished";
    case "RunFailed":
      return "failed";
    case "RunCancelled":
      return "cancelled";
    case undefined:
      break;
  }
  if (input.streaming) return "running";
  if (input.summary === undefined) return "interrupted";
  return runDisplayStatus(input.summary);
}

const RUN_LABELS: Record<RunDisplayStatus, string> = {
  running: "running",
  finished: "finished",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

const STEP_LABELS: Record<StepDisplayStatus, string> = {
  running: "running",
  completed: "complete",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  pass: "pass",
  fail: "fail",
  pending: "pending",
  neutral: "log",
};

export function statusLabel(status: DisplayStatus): string {
  return status in RUN_LABELS
    ? RUN_LABELS[status as RunDisplayStatus]
    : STEP_LABELS[status as StepDisplayStatus];
}

/** Only live statuses pulse — the one animation in the panel. */
export function isPulsing(status: DisplayStatus): boolean {
  return status === "running";
}
