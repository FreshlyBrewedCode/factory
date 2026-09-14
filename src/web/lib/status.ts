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
