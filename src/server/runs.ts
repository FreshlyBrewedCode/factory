/**
 * The server's in-memory run registry: which runs are currently live in
 * *this* process, so the HTTP API can cancel them and the dispatcher can
 * enforce a WIP limit (D24, D29). Deliberately not derived from sqlite — a
 * run whose process died is "interrupted" (D12), not "active"; only a
 * `RunHandle` this process actually holds counts.
 *
 * A run is registered *before* it starts: `startTrackedRun` reserves the
 * registry slot synchronously (check-then-set with no `await` between, so a
 * concurrent HTTP start cannot lose the race) and only then allocates the
 * workspace. A reserved slot is released if allocation/startup fails, and a
 * `cancel` that arrives while a run is still reserving is deferred into run
 * start rather than dropped.
 */

import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { admitRun } from "./admission";
import { appendEvent, listRuns } from "../persistence/store";
import type { RunRepo } from "../runtime/run";
import { startRun, type RunHandle } from "../runtime/run";
import type { GitIdentity } from "../lib/clone";
import { allocateWorkspace } from "../lib/workspace";
import type { AgentAdapter } from "../runtime/agent-adapter";
import type { WorkflowDefinition, WorkspaceKind } from "../workflow";
import { publish } from "./pubsub";

interface ReservedSlot {
  cancelled: boolean;
}

const active = new Map<string, RunHandle<unknown> | ReservedSlot>();

function isReserved(entry: RunHandle<unknown> | ReservedSlot | undefined): boolean {
  return entry !== undefined && !("result" in entry) && "cancelled" in entry;
}

export class ConcurrencyLimitError extends Error {
  constructor(maxConcurrentRuns: number) {
    super(`concurrency limit reached (max ${maxConcurrentRuns} concurrent runs)`);
    this.name = "ConcurrencyLimitError";
  }
}

export function isActive(runId: string): boolean {
  return active.has(runId);
}

export function activeRunIds(): ReadonlyArray<string> {
  return [...active.keys()];
}

export function getActiveHandle(runId: string): RunHandle<unknown> | undefined {
  const entry = active.get(runId);
  if (entry === undefined || isReserved(entry)) return undefined;
  return entry as RunHandle<unknown>;
}

/**
 * Cancellation for a run this process holds — whether it is already running
 * (returns its handle), still reserving/allocation-bound (marks the slot so
 * the run is cancelled the moment it starts), or unknown (`undefined`).
 */
export function cancelRegisteredRun(runId: string):
  | { readonly kind: "handle"; readonly handle: RunHandle<unknown> }
  | {
      readonly kind: "reserved";
    }
  | undefined {
  const entry = active.get(runId);
  if (entry === undefined) return undefined;
  if (isReserved(entry)) {
    (entry as ReservedSlot).cancelled = true;
    return { kind: "reserved" };
  }
  return { kind: "handle", handle: entry as RunHandle<unknown> };
}

export interface WorkspaceSpec {
  readonly workspaceRoot: string;
  readonly sshUrl: string;
  readonly identity: GitIdentity;
  readonly retainedWorkspaces: number;
}

export interface StartTrackedRunOptions {
  /** An explicit directory wins; otherwise `workspace` allocates one per runId (D28). */
  readonly dir?: string;
  readonly workspace?: WorkspaceSpec;
  /** Write-back environment for the run (D32): came from config, not the caller. */
  readonly repo?: RunRepo;
  readonly input: unknown;
  readonly adapter: AgentAdapter;
  readonly runId?: string;
  /**
   * D29's ceiling, enforced atomically at reservation time — the reservation
   * lands in the registry before any `await`, so two near-simultaneous
   * start requests cannot both slip past it. Absent, no limit applies.
   */
  readonly maxConcurrentRuns?: number;
  /** Injectable for tests: holds the reserved-but-not-started window open. */
  readonly beforeStart?: () => Promise<void>;
}

/** Starts a run, persists+publishes every event, and tracks it until terminal. */
export async function startTrackedRun(
  db: Database,
  workflow: WorkflowDefinition<any, any>,
  options: StartTrackedRunOptions,
): Promise<string> {
  // crypto.randomUUID(), not `run-${Date.now()}`: the server can have more than one run start
  // within the same millisecond (concurrent HTTP POSTs, or tests running in the same process),
  // and a collided runId cross-wires the pubsub channel and `active` registry between two
  // unrelated runs — one run's SSE watcher can then see the other's terminal event and close
  // its own db while its real run is still writing to it.
  const runId = options.runId ?? `run-${crypto.randomUUID()}`;

  const existing = active.get(runId);
  if (existing !== undefined && !isReserved(existing)) {
    throw new Error(`run ${runId} is already active`);
  }
  if (existing === undefined && options.maxConcurrentRuns !== undefined) {
    if (!admitRun(options.maxConcurrentRuns, active.size)) {
      throw new ConcurrencyLimitError(options.maxConcurrentRuns);
    }
    active.set(runId, { cancelled: false });
  }

  try {
    if (options.beforeStart !== undefined) await options.beforeStart();

    // Issue #13: a scratch workspace takes its kind from the workflow and
    // never evicts clone workspaces — leftover scratch dirs (kept failures)
    // are excluded from retention via the run log's recorded kinds.
    const kind: WorkspaceKind = workflow.workspace?.kind ?? "clone";
    const scratchEntries =
      options.workspace !== undefined && kind === "scratch"
        ? undefined
        : new Set(
            listRuns(db)
              .filter((run) => run.workspaceKind === "scratch")
              .map((run) => run.runId),
          );

    const dir =
      options.dir ??
      (options.workspace === undefined
        ? undefined
        : await allocateWorkspace({
            runId,
            ...options.workspace,
            kind,
            ...(scratchEntries !== undefined ? { scratchEntries } : {}),
            protectedEntries: [runId, ...activeRunIds()],
          }));

    if (dir === undefined) throw new Error("startTrackedRun needs `dir` or `workspace`");

    // Whether the runtime allocated this dir itself (explicit callers' dirs,
    // incl. the legacy path-based API, are not reaped — they are caller-owned).
    const workspaceAllocated = options.dir === undefined;

    const handle = startRun(workflow, {
      runId,
      dir,
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
      workspaceKind: kind,
      input: options.input,
      adapter: options.adapter,
      onEvent: (event) => {
        appendEvent(db, event);
        publish(runId, event);
      },
    });

    // A cancel that arrived while this run was only a reserved slot is
    // deferred into run start (L1): the run starts, is cancelled immediately,
    // and ends as a clean RunCancelled instead of orphaning the slot.
    const beforeStartEntry = active.get(runId);
    const reservedSlot = isReserved(beforeStartEntry)
      ? (beforeStartEntry as ReservedSlot)
      : undefined;
    const cancelRequested = reservedSlot?.cancelled === true;
    active.set(runId, handle);

    void handle.result.finally(() => {
      if (active.get(runId) === handle) active.delete(runId);
    });

    // Issue #13: a scratch dir is reaped when the run succeeds — there is no
    // tree worth keeping, and retention never applies to it. It is kept when
    // the run fails (or is cancelled) so a failed precondition check remains
    // inspectable.
    void handle.result.then((outcome) => {
      if (workspaceAllocated && kind === "scratch" && outcome.outcome === "completed") {
        void rm(dir, { recursive: true, force: true });
      }
    });

    if (cancelRequested) void handle.cancel();

    return runId;
  } catch (err) {
    const current = active.get(runId);
    if (current === undefined || isReserved(current)) active.delete(runId);
    throw err;
  }
}
