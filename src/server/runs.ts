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

import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { admitRun } from "./admission";
import { appendEvent, getRunEvents, listRuns } from "../persistence/store";
import type { RunRepo } from "../runtime/run";
import { startRun, type RunHandle } from "../runtime/run";
import type { GitIdentity } from "../lib/clone";
import { allocateWorkspace, type RefreshGates } from "../lib/workspace";
import type { DedupeRegistry } from "../lib/dedupe";
import type { AgentAdapter } from "../runtime/agent-adapter";
import type { DispatchChildFn, WorkflowDefinition, WorkspaceKind } from "../workflow";
import type { PubSub } from "./pubsub";

interface ReservedSlot {
  cancelled: boolean;
}

function isReserved(entry: RunHandle<unknown> | ReservedSlot | undefined): boolean {
  return entry !== undefined && !("result" in entry) && "cancelled" in entry;
}

export const DEFAULT_MAX_DISPATCH_DEPTH = 5;
export const DEFAULT_MAX_CHILDREN_PER_RUN = 20;

export class DispatchCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchCapError";
  }
}

export class ConcurrencyLimitError extends Error {
  constructor(maxConcurrentRuns: number) {
    super(`concurrency limit reached (max ${maxConcurrentRuns} concurrent runs)`);
    this.name = "ConcurrencyLimitError";
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
  cancelRegisteredRun(runId: string):
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
  readonly dir?: string;
  readonly workspace?: WorkspaceSpec;
  readonly repo?: RunRepo;
  readonly input: unknown;
  readonly adapter: AgentAdapter;
  readonly runId?: string;
  readonly maxConcurrentRuns?: number;
  readonly dispatchEnv?: DispatchEnv;
  readonly parentRunId?: string;
  readonly dedupeKey?: string;
  readonly dedupeKeyClaimed?: boolean;
  readonly scheduleId?: string;
  readonly agentOverrides?: { readonly model?: string };
  readonly prepareWorkspace?: boolean;
}

export interface DispatchEnv {
  readonly workspace?: WorkspaceSpec;
  readonly repo?: RunRepo;
  readonly maxConcurrentRuns?: number;
  readonly adapter: AgentAdapter;
  readonly maxDispatchDepth?: number;
  readonly maxChildrenPerRun?: number;
}

function parentOf(db: Database, runId: string): string | undefined {
  const started = getRunEvents(db, runId).find((event) => event.payload._tag === "RunStarted");
  if (started === undefined || started.payload._tag !== "RunStarted") return undefined;
  return started.payload.parentId;
}

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

async function dispatchChildRun(
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
    throw new ConcurrencyLimitError(env.maxConcurrentRuns);
  }

  const depth = dispatchDepth(db, parentRunId);
  if (depth + 1 > maxDepth) {
    throw new DispatchCapError(
      `dispatch depth exceeded: run ${parentRunId} is nested ${depth} levels deep; ` +
        `max ${maxDepth} (a workflow that dispatches itself must not fill the daemon)`,
    );
  }
  const childCount = countDispatchedChildren(db, parentRunId);
  if (childCount >= maxChildren) {
    throw new DispatchCapError(
      `dispatch child cap exceeded: run ${parentRunId} already dispatched ${childCount} children; max ${maxChildren}`,
    );
  }

  const childRunId = `run-${crypto.randomUUID()}`;
  if (opts?.dedupeKey !== undefined) services.dedupeRegistry.claim(opts.dedupeKey, childRunId);

  void (async () => {
    await startTrackedRun(db, services, child, {
      runId: childRunId,
      ...(env.workspace !== undefined ? { workspace: env.workspace } : {}),
      ...(env.repo !== undefined ? { repo: env.repo } : {}),
      ...(env.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: env.maxConcurrentRuns } : {}),
      input,
      adapter: env.adapter,
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

export async function startTrackedRun(
  db: Database,
  services: DaemonServices,
  workflow: WorkflowDefinition<any, any>,
  options: StartTrackedRunOptions,
): Promise<string> {
  const runId = options.runId ?? `run-${crypto.randomUUID()}`;
  const registry = services.registry;

  const existing = registry.get(runId);
  if (existing !== undefined && !isReserved(existing)) {
    throw new Error(`run ${runId} is already active`);
  }

  if (options.dedupeKey !== undefined && options.dedupeKeyClaimed !== true) {
    services.dedupeRegistry.claim(options.dedupeKey, runId);
  }
  if (existing === undefined && options.maxConcurrentRuns !== undefined) {
    if (!admitRun(options.maxConcurrentRuns, registry.size)) {
      throw new ConcurrencyLimitError(options.maxConcurrentRuns);
    }
    registry.reserve(runId);
  }

  try {
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

    const workspaceAllocated = options.dir === undefined;

    const dispatch: DispatchChildFn | undefined =
      options.dispatchEnv === undefined
        ? undefined
        : (child, input, opts) =>
            dispatchChildRun(db, services, options.dispatchEnv!, runId, child, input, opts);

    const handle = startRun(workflow, {
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
      adapter: options.adapter,
      onEvent: (event) => {
        appendEvent(db, event);
        services.pubsub.publish(runId, event);
      },
    });

    const beforeStartEntry = registry.get(runId);
    const reservedSlot = isReserved(beforeStartEntry)
      ? (beforeStartEntry as ReservedSlot)
      : undefined;
    const cancelRequested = reservedSlot?.cancelled === true;
    registry.setHandle(runId, handle);

    void handle.result.finally(() => {
      if (registry.get(runId) === handle) registry.delete(runId);
      if (options.dedupeKey !== undefined) services.dedupeRegistry.release(options.dedupeKey, runId);
    });

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
