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
 *
 * #38: the active-run registry, pubsub, and dedupe registry are now
 * per-daemon instances passed through `DaemonServices`, so two daemons can
 * coexist in one process without sharing state.
 */

import { Schema, type ManagedRuntime } from "effect";
import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { admitRun } from "./admission";
import { appendEvent, getRunEvents, listRuns } from "../persistence/store";
import type { RunRepo } from "../runtime/run";
import { startRun, type RunHandle } from "../runtime/run";
import type { GitIdentity } from "../lib/clone";
import { allocateWorkspace, type RefreshGates } from "../lib/workspace";
import type { DedupeRegistry } from "../lib/dedupe";
import type { AgentRuntime } from "../runtime/agent-runtime";
import type { DispatchChildFn, WorkflowDefinition, WorkspaceKind } from "../workflow";
import type { PubSub } from "./pubsub";

interface ReservedSlot {
  cancelled: boolean;
}

/**
 * Issue #14: how deep a parent → child → grandchild chain may nest — the cap
 * that keeps a workflow which dispatches itself from filling the daemon.
 */
export const DEFAULT_MAX_DISPATCH_DEPTH = 5;
/** Issue #14: how many children one run itself may dispatch. */
export const DEFAULT_MAX_CHILDREN_PER_RUN = 20;

/** Issue #14: a `ctx.dispatch` rejected by a cap, for the parent to surface. */
export class DispatchCapError extends Schema.TaggedError<DispatchCapError>()("DispatchCapError", {
  message: Schema.String,
}) {}

function isReserved(entry: RunHandle<unknown> | ReservedSlot | undefined): boolean {
  return entry !== undefined && !("result" in entry) && "cancelled" in entry;
}

export class ConcurrencyLimitError extends Schema.TaggedError<ConcurrencyLimitError>()(
  "ConcurrencyLimitError",
  { maxConcurrentRuns: Schema.Number, message: Schema.String },
) {
  // Bun takes the `.stack` header from the *immediate* prototype's `name`;
  // the schema class sets it one level up, which would leave `Error: …`.
  static {
    this.prototype.name = "ConcurrencyLimitError";
  }

  /**
   * The single source of truth for the message (HTTP, runtime, scheduler
   * alike). Built at construction — not a getter — so `.stack` opens with it too.
   */
  static of(props: { readonly maxConcurrentRuns: number }): ConcurrencyLimitError {
    return new ConcurrencyLimitError({
      ...props,
      message: `concurrency limit reached (max ${props.maxConcurrentRuns} concurrent runs)`,
    });
  }
}

export interface DaemonServices {
  readonly registry: RunRegistry;
  readonly pubsub: PubSub;
  readonly dedupeRegistry: DedupeRegistry;
  readonly refreshGates: RefreshGates;
}

export interface RunRegistry {
  isActive(runId: string): boolean;
  activeRunIds(): ReadonlyArray<string>;
  getActiveHandle(runId: string): RunHandle<unknown> | undefined;
  /**
   * Cancellation for a run this registry holds — whether it is already
   * running (returns its handle), still reserving/allocation-bound (marks the
   * slot so the run is cancelled the moment it starts), or unknown
   * (`undefined`).
   */
  cancelRegisteredRun(
    runId: string,
  ):
    | { readonly kind: "handle"; readonly handle: RunHandle<unknown> }
    | { readonly kind: "reserved" }
    | undefined;
  reserve(runId: string): void;
  setHandle(runId: string, handle: RunHandle<unknown>): void;
  delete(runId: string): void;
  get(runId: string): RunHandle<unknown> | ReservedSlot | undefined;
  size: number;
}

export function createRunRegistry(): RunRegistry {
  const active = new Map<string, RunHandle<unknown> | ReservedSlot>();
  return {
    isActive: (runId) => active.has(runId),
    activeRunIds: () => [...active.keys()],
    getActiveHandle(runId) {
      const entry = active.get(runId);
      if (entry === undefined || isReserved(entry)) return undefined;
      return entry as RunHandle<unknown>;
    },
    cancelRegisteredRun(runId) {
      const entry = active.get(runId);
      if (entry === undefined) return undefined;
      if (isReserved(entry)) {
        (entry as ReservedSlot).cancelled = true;
        return { kind: "reserved" };
      }
      return { kind: "handle", handle: entry as RunHandle<unknown> };
    },
    reserve(runId) {
      active.set(runId, { cancelled: false });
    },
    setHandle(runId, handle) {
      active.set(runId, handle);
    },
    delete(runId) {
      active.delete(runId);
    },
    get(runId) {
      return active.get(runId);
    },
    get size() {
      return active.size;
    },
  };
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
  readonly runId?: string;
  /**
   * D29's ceiling, enforced atomically at reservation time — the reservation
   * lands in the registry before any `await`, so two near-simultaneous
   * start requests cannot both slip past it. Absent, no limit applies.
   */
  readonly maxConcurrentRuns?: number;
  /**
   * Issue #14: the environment a child run of this run starts with, so
   * `ctx.dispatch` can allocate a workspace, admission-limit and repo for it.
   * Absent, the workflow's `ctx.dispatch` throws (dispatch needs a
   * config-backed daemon run; in-process execution is legacy). Children
   * inherit it, so grandchildren work too.
   */
  readonly dispatchEnv?: DispatchEnv;
  /**
   * Issue #14: this run's parent, when it was started by `ctx.dispatch` —
   * recorded on `RunStarted.parentId` so the UI can navigate child → parent.
   */
  readonly parentRunId?: string;
  /**
   * Issue #15: this run's dedupe key. Claimed synchronously at start (before
   * any await) in the run's own registry slot manner — two near-simultaneous
   * starts with the same key cannot both slip through the check-then-claim —
   * and released the moment the run settles in any terminal state, including
   * a failed startup. Absent, the run claims nothing.
   */
  readonly dedupeKey?: string;
  /**
   * Issue #15: `true` when a caller (the dispatch path) already claimed the
   * key synchronously before handing the start over, so the claim must not be
   * re-asserted here. Release still happens here, keyed to this run id.
   */
  readonly dedupeKeyClaimed?: boolean;
  /**
   * Issue #16: the schedule that started this run, when any did - passed
   * through to `RunStarted.scheduleId`.
   */
  readonly scheduleId?: string;
  /**
   * Issue #16: agent-level overrides the starting schedule carries. Passed
   * through to the run's model precedence chain.
   */
  readonly agentOverrides?: { readonly model?: string };
  /**
   * ADR 0012 §3 (#37): when true, the runtime calls `adapter.prepareWorkspace`
   * before the workflow runs. The caller sets this when it has done a
   * `resetClone` on `dir`. Combined with the daemon's own allocation check,
   * this covers both clone paths.
   */
  readonly prepareWorkspace?: boolean;
}

/**
 * The environment `ctx.dispatch`'s children share with their parent (issue
 * #14): workspace provisioning, write-back environment and the
 * concurrency ceiling — the same wiring a config-backed server wraps every
 * run in, simply reused for child runs (children inherit it, so a child can
 * dispatch grandchildren).
 */
export interface DispatchEnv {
  readonly workspace?: WorkspaceSpec;
  readonly repo?: RunRepo;
  readonly maxConcurrentRuns?: number;
  /** Issue #14: dispatch depth / per-run child caps, over the defaults. */
  readonly maxDispatchDepth?: number;
  readonly maxChildrenPerRun?: number;
}

/**
 * The run this `runId` was started from (`RunStarted.parentId`), or none —
 * a run started without `ctx.dispatch` has no parent.
 */
function parentOf(db: Database, runId: string): string | undefined {
  const started = getRunEvents(db, runId).find((event) => event.payload._tag === "RunStarted");
  if (started === undefined || started.payload._tag !== "RunStarted") return undefined;
  return started.payload.parentId;
}

/** How deep this run sits in the parent → child chain (a top-level run is 0). */
function dispatchDepth(db: Database, runId: string): number {
  let depth = 0;
  let cursor = runId;
  while (true) {
    const parent = parentOf(db, cursor);
    if (parent === undefined) break;
    depth += 1;
    cursor = parent;
  }
  return depth;
}

/**
 * Issue #14: start a child run of `parentRunId`.
 *
 * Every rejection is a throw, so `ctx.dispatch` rejects and the *parent*
 * fails visibly — nothing about a child's admission is allowed to be a
 * silent drop. The checks are synchronous over in-memory state and the sync
 * sqlite event log, so by the time the parent carries on, admission has
 * already happened. A validated child is started without being awaited: the
 * parent never exposes an awaitable child (D-epic 19). The child's own
 * startup failures land on the child's event log / console, never in the
 * parent's.
 */
async function dispatchChildRun(
  runtime: ManagedRuntime.ManagedRuntime<AgentRuntime, never>,
  db: Database,
  services: DaemonServices,
  env: DispatchEnv,
  parentRunId: string,
  child: WorkflowDefinition<any, any>,
  input: unknown,
  opts?: { readonly dedupeKey?: string },
): Promise<string> {
  const maxDepth = env.maxDispatchDepth ?? DEFAULT_MAX_DISPATCH_DEPTH;
  const maxChildren = env.maxChildrenPerRun ?? DEFAULT_MAX_CHILDREN_PER_RUN;
  const registry = services.registry;

  if (
    env.maxConcurrentRuns !== undefined &&
    !admitRun(env.maxConcurrentRuns, registry.activeRunIds().length)
  ) {
    throw ConcurrencyLimitError.of({ maxConcurrentRuns: env.maxConcurrentRuns });
  }

  const depth = dispatchDepth(db, parentRunId);
  if (depth + 1 > maxDepth) {
    throw new DispatchCapError({
      message:
        `dispatch depth exceeded: run ${parentRunId} is nested ${depth} levels deep; ` +
        `max ${maxDepth} (a workflow that dispatches itself must not fill the daemon)`,
    });
  }
  const childCount = countDispatchedChildren(db, parentRunId);
  if (childCount >= maxChildren) {
    throw new DispatchCapError({
      message: `dispatch child cap exceeded: run ${parentRunId} already dispatched ${childCount} children; max ${maxChildren}`,
    });
  }

  // Issue #15: the collision check is synchronous with the child id in hand
  // and *before* the fire-and-forget start, so a collision throws into the
  // parent here instead of being swallowed by the un-awaited start's catch.
  const childRunId = `run-${crypto.randomUUID()}`;
  if (opts?.dedupeKey !== undefined) services.dedupeRegistry.claim(opts.dedupeKey, childRunId);

  void (async () => {
    await startTrackedRun(runtime, db, services, child, {
      runId: childRunId,
      ...(env.workspace !== undefined ? { workspace: env.workspace } : {}),
      ...(env.repo !== undefined ? { repo: env.repo } : {}),
      ...(env.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: env.maxConcurrentRuns } : {}),
      input,
      parentRunId,
      dispatchEnv: env,
      ...(opts?.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
      ...(opts?.dedupeKey !== undefined ? { dedupeKeyClaimed: true } : {}),
    }).catch((err: unknown) => {
      if (opts?.dedupeKey !== undefined) {
        services.dedupeRegistry.release(opts.dedupeKey, childRunId);
      }
      console.error(
        `nested run start failed (parent ${parentRunId}, child ${childRunId}):` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
  })();

  return childRunId;
}

function countDispatchedChildren(db: Database, runId: string): number {
  return getRunEvents(db, runId).filter((event) => event.payload._tag === "RunDispatched").length;
}

/** Starts a run, persists+publishes every event, and tracks it until terminal. */
export async function startTrackedRun(
  runtime: ManagedRuntime.ManagedRuntime<AgentRuntime, never>,
  db: Database,
  services: DaemonServices,
  workflow: WorkflowDefinition<any, any>,
  options: StartTrackedRunOptions,
): Promise<string> {
  // crypto.randomUUID(), not `run-${Date.now()}`: the server can have more than one run start
  // within the same millisecond (concurrent HTTP POSTs, or tests running in the same process),
  // and a collided runId cross-wires the pubsub channel and `active` registry between two
  // unrelated runs — one run's SSE watcher can then see the other's terminal event and close
  // its own db while its real run is still writing to it.
  const runId = options.runId ?? `run-${crypto.randomUUID()}`;
  const registry = services.registry;

  const existing = registry.get(runId);
  if (existing !== undefined && !isReserved(existing)) {
    throw new Error(`run ${runId} is already active`);
  }

  // D29 admission is decided before the dedupe claim, so a refused start
  // throws having claimed nothing — otherwise its key would stay held by a
  // run that never started (and a `"skip"` schedule would skip forever).
  const limit = existing === undefined ? options.maxConcurrentRuns : undefined;
  if (limit !== undefined && !admitRun(limit, registry.size)) {
    throw ConcurrencyLimitError.of({ maxConcurrentRuns: limit });
  }
  // Issue #15: claim the dedupe key synchronously — check-then-claim with no
  // `await` in between, the same atomicity the registry slot reservation has —
  // so two near-simultaneous starts on the same key cannot both slip past. A
  // collision throws before anything is started, leaving no trace.
  if (options.dedupeKey !== undefined && options.dedupeKeyClaimed !== true) {
    services.dedupeRegistry.claim(options.dedupeKey, runId);
  }
  if (limit !== undefined) registry.reserve(runId);

  try {
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
            protectedEntries: [runId, ...registry.activeRunIds()],
            refreshGates: services.refreshGates,
          }));

    if (dir === undefined) throw new Error("startTrackedRun needs `dir` or `workspace`");

    // Whether the runtime allocated this dir itself (explicit callers' dirs,
    // incl. the legacy path-based API, are not reaped — they are caller-owned).
    const workspaceAllocated = options.dir === undefined;

    // Issue #14: the per-run dispatch member comes from the run's dispatch
    // environment, bound at this run's id — the parent's own log is where the
    // depth walk and the child count are read from.
    const dispatch: DispatchChildFn | undefined =
      options.dispatchEnv === undefined
        ? undefined
        : (child, input, opts) =>
            dispatchChildRun(
              runtime,
              db,
              services,
              options.dispatchEnv!,
              runId,
              child,
              input,
              opts,
            );

    const handle = startRun(workflow, runtime, {
      runId,
      dir,
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
      workspaceKind: kind,
      prepareWorkspace:
        options.prepareWorkspace === true || (workspaceAllocated && kind === "clone"),
      ...(dispatch !== undefined ? { dispatch } : {}),
      ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
      ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
      ...(options.scheduleId !== undefined ? { scheduleId: options.scheduleId } : {}),
      ...(options.agentOverrides !== undefined ? { agentOverrides: options.agentOverrides } : {}),
      input: options.input,
      onEvent: (event) => {
        appendEvent(db, event);
        services.pubsub.publish(runId, event);
      },
    });

    // A cancel that arrived while this run was only a reserved slot is
    // deferred into run start (L1): the run starts, is cancelled immediately,
    // and ends as a clean RunCancelled instead of orphaning the slot.
    const beforeStartEntry = registry.get(runId);
    const reservedSlot = isReserved(beforeStartEntry)
      ? (beforeStartEntry as ReservedSlot)
      : undefined;
    const cancelRequested = reservedSlot?.cancelled === true;
    registry.setHandle(runId, handle);

    void handle.result.finally(() => {
      if (registry.get(runId) === handle) registry.delete(runId);
      // Issue #15: any terminal state — completed, failed, cancelled —
      // releases the run's key. (An interrupted run — process death — is
      // covered by the registry being per-daemon: a new daemon holds
      // nothing.)
      if (options.dedupeKey !== undefined)
        services.dedupeRegistry.release(options.dedupeKey, runId);
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
    if (options.dedupeKey !== undefined) services.dedupeRegistry.release(options.dedupeKey, runId);
    const current = registry.get(runId);
    if (current === undefined || isReserved(current)) registry.delete(runId);
    throw err;
  }
}
