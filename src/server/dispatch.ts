/**
 * The reconciliation loop (STATUS.md phase 3, porting
 * `wayful/scripts/dispatch-ready-issues.sh`'s claim-lock/WIP-limit/backoff
 * semantics onto Factory's shape).
 *
 * D24: no separate retry-state file. The wayful script tracks backoff in a
 * TSV keyed by thread id; Factory already has a durable, per-issue history
 * in `events` (D21) — `RunStarted.input.issueNumber` is the join key, so
 * backoff is *derived* at reconcile time from `listRuns`/`getRunEvents`
 * rather than written to a second store that could drift from the log.
 *
 * `reconcileOnce` is a plain `async` function, deliberately not wrapped in
 * Effect's scheduling — same split as `store.ts`: the *logic* is synchronous
 * decision-making with nothing to bridge, so it stays a directly-testable
 * plain function. `runDispatchLoop` is the thin Effect layer around it
 * (`Effect.repeat(Schedule.spaced(...))`), which is where D4's "Effect owns
 * ... scheduling" actually applies — a genuine long-running, repeating
 * process, not a one-shot request handler.
 *
 * WIP limit is 1 concurrent run, enforced via `hasActiveRun` (checked against
 * the *current process's* live registry, `src/server/runs.ts` — a run whose
 * process died is "interrupted" (D12), not active, so it doesn't block new
 * dispatch after a restart). This is deliberately simpler than the wayful
 * script's global pause-on-any-failed-thread: Factory has no resumable
 * "continue this thread" concept (workflows are one-shot `async` functions,
 * D19), so a retry is a fresh run, and pausing *all* dispatch for one
 * failing issue would starve unrelated Ready issues for no benefit here.
 * Per-issue backoff is scoped to the issue that's actually failing.
 */

import type { Database } from "bun:sqlite";
import { Effect, Schedule, Schema } from "effect";
import { getRunEvents, listRuns, type RunStatus } from "../persistence/store";
import type { ReadyItem, ReadySource } from "./ready-source";

export class ReconcileError extends Schema.TaggedError<ReconcileError>()("ReconcileError", {
  cause: Schema.Defect(),
}) {}

export interface DispatchConfig {
  readonly repoSlug: string;
  readonly baseBranch: string;
  /** Minutes before the first retry after a failure. Doubles per consecutive failure. */
  readonly backoffBaseMinutes: number;
  /** Ceiling on the doubling, matching the wayful script's 1440 (24h). */
  readonly backoffCapMinutes: number;
}

export const DEFAULT_DISPATCH_CONFIG: Pick<
  DispatchConfig,
  "backoffBaseMinutes" | "backoffCapMinutes"
> = {
  backoffBaseMinutes: 15,
  backoffCapMinutes: 1440,
};

export interface ReconcileDeps {
  readonly db: Database;
  readonly source: ReadySource;
  readonly config: DispatchConfig;
  readonly hasActiveRun: () => boolean;
  /** Starts the run for a claimed item and returns its `runId`. */
  readonly dispatch: (item: ReadyItem) => Promise<string>;
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export type ReconcileResult =
  | { readonly action: "skipped-wip-limit" }
  | { readonly action: "no-eligible-items" }
  | { readonly action: "skipped-claim-failed"; readonly issueNumber: number }
  | { readonly action: "dispatched"; readonly issueNumber: number; readonly runId: string };

interface IssueHistory {
  readonly lastStatus: RunStatus | "interrupted" | undefined;
  readonly lastFinishedAt: number | undefined;
  readonly consecutiveFailures: number;
}

function historyForIssue(db: Database, issueNumber: number): IssueHistory {
  const matching = listRuns(db)
    .filter((run) => {
      const started = getRunEvents(db, run.runId).find((e) => e.payload._tag === "RunStarted");
      if (started === undefined || started.payload._tag !== "RunStarted") return false;
      const input = started.payload.input as { readonly issueNumber?: unknown };
      return input.issueNumber === issueNumber;
    })
    .sort((a, b) => a.startedAt - b.startedAt);

  let consecutiveFailures = 0;
  for (let i = matching.length - 1; i >= 0; i--) {
    if (matching[i]?.status !== "RunFailed") break;
    consecutiveFailures++;
  }

  const last = matching.at(-1);
  return { lastStatus: last?.status, lastFinishedAt: last?.finishedAt, consecutiveFailures };
}

function backoffElapsed(history: IssueHistory, config: DispatchConfig, now: number): boolean {
  if (history.lastStatus !== "RunFailed" || history.lastFinishedAt === undefined) return true;
  // consecutiveFailures is >= 1 here; the 1st failure backs off by the base amount, doubling per failure after.
  const backoffMinutes = Math.min(
    config.backoffBaseMinutes * 2 ** (history.consecutiveFailures - 1),
    config.backoffCapMinutes,
  );
  const elapsedMinutes = (now - history.lastFinishedAt) / 60_000;
  return elapsedMinutes >= backoffMinutes;
}

/**
 * One reconciliation pass: at most one item claimed and dispatched (the WIP
 * limit is 1), in the source's own ordering. Hard-blocked items and items
 * still inside their backoff window are skipped without consuming the claim.
 */
export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileResult> {
  if (deps.hasActiveRun()) return { action: "skipped-wip-limit" };

  const now = deps.now?.() ?? Date.now();
  const items = await deps.source.listReady();

  for (const item of items) {
    if (item.hardBlockedBy.length > 0) continue;

    const history = historyForIssue(deps.db, item.issueNumber);
    if (!backoffElapsed(history, deps.config, now)) continue;

    const claimed = await deps.source.claim(item);
    if (!claimed) return { action: "skipped-claim-failed", issueNumber: item.issueNumber };

    const runId = await deps.dispatch(item);
    return { action: "dispatched", issueNumber: item.issueNumber, runId };
  }

  return { action: "no-eligible-items" };
}

/** The daemon's actual poll loop — `Effect.repeat` around the plain `reconcileOnce`. */
export function runDispatchLoop(deps: ReconcileDeps, intervalMs: number): Effect.Effect<unknown> {
  const tick = Effect.tryPromise({
    try: () => reconcileOnce(deps),
    catch: (cause: unknown) => new ReconcileError({ cause }),
  }).pipe(
    Effect.match({
      onFailure: (error: ReconcileError) => {
        console.error("[dispatch] reconcile failed:", error.cause);
      },
      onSuccess: (result: ReconcileResult) => {
        if (result.action !== "no-eligible-items" && result.action !== "skipped-wip-limit") {
          console.log(`[dispatch] ${JSON.stringify(result)}`);
        }
      },
    }),
  );

  return Effect.repeat(tick, Schedule.spaced(intervalMs));
}
