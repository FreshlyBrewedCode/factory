/**
 * The server's in-memory run registry: which runs are currently live in
 * *this* process, so the HTTP API can cancel them and the dispatcher can
 * enforce a WIP limit (D24, D29).
 */

import type { Database } from "bun:sqlite";
import type { ManagedRuntime } from "effect";
import { rm } from "node:fs/promises";
import { admitRun } from "./admission";
import { appendEvent, getRunEvents, listRuns } from "../persistence/store";
import type { RunRepo } from "../runtime/run";
import { startRun, type RunHandle } from "../runtime/run";
import type { GitIdentity } from "../lib/clone";
import { allocateWorkspace } from "../lib/workspace";
import { dedupeRegistry, type DedupeRegistry } from "../lib/dedupe";
import type { DispatchChildFn, WorkflowDefinition, WorkspaceKind } from "../workflow";
import { publish } from "./pubsub";
import { AgentRuntime } from "../runtime/agent-runtime";

interface ReservedSlot {
  cancelled: boolean;
}

const active = new Map<string, RunHandle<unknown> | ReservedSlot>();

export const DEFAULT_MAX_DISPATCH_DEPTH = 5;
export const DEFAULT_MAX_CHILDREN_PER_RUN = 20;

export class DispatchCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchCapError";
  }
}

function isReserved(entry: RunHandle<unknown> | ReservedSlot | undefined): boolean {
  return entry !== undefined && !("result" in entry) && "cancelled" in entry;
}

export class ConcurrencyLimitError extends Schema.TaggedError<ConcurrencyLimitError>()(
  "ConcurrencyLimitError",
  { maxConcurrentRuns: Schema.Number },
) {
  /** The single source of truth for the message (HTTP, runtime, scheduler alike). */
  override get message(): string {
    return `concurrency limit reached (max ${this.maxConcurrentRuns} concurrent runs)`;
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

export function cancelRegisteredRun(
  runId: string,
):
  | { readonly kind: "handle"; readonly handle: RunHandle<unknown> }
  | { readonly kind: "reserved" }
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
  readonly dir?: string;
  readonly workspace?: WorkspaceSpec;
  readonly repo?: RunRepo;
  readonly input: unknown;
  readonly runId?: string;
  readonly maxConcurrentRuns?: number;
  readonly beforeStart?: () => Promise<void>;
  readonly dispatchEnv?: DispatchEnv;
  readonly parentRunId?: string;
  readonly dedupeKey?: string;
  readonly dedupeKeyClaimed?: boolean;
  readonly dedupeRegistry?: DedupeRegistry;
  readonly scheduleId?: string;
  readonly agentOverrides?: { readonly model?: string };
  /**
   * ADR 0012 §3 (#37): when true, the runtime calls `adapter.prepareWorkspace`
   * before the workflow runs. The caller sets this when it has done a
   * `resetClone` on `dir`. Combined with the daemon's own allocation check,
   * this covers both clone paths.
   */
  readonly prepareWorkspace?: boolean;
}

export interface DispatchEnv {
  readonly workspace?: WorkspaceSpec;
  readonly repo?: RunRepo;
  readonly maxConcurrentRuns?: number;
  readonly maxDispatchDepth?: number;
  readonly maxChildrenPerRun?: number;
  readonly dedupeRegistry?: DedupeRegistry;
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

function countDispatchedChildren(db: Database, runId: string): number {
  return getRunEvents(db, runId).filter((event) => event.payload._tag === "RunDispatched").length;
}

async function dispatchChildRun(
  runtime: ManagedRuntime.ManagedRuntime<AgentRuntime, never>,
  db: Database,
  env: DispatchEnv,
  parentRunId: string,
  child: WorkflowDefinition<any, any>,
  input: unknown,
  opts?: { readonly dedupeKey?: string },
): Promise<string> {
  const maxDepth = env.maxDispatchDepth ?? DEFAULT_MAX_DISPATCH_DEPTH;
  const maxChildren = env.maxChildrenPerRun ?? DEFAULT_MAX_CHILDREN_PER_RUN;
  const registry = env.dedupeRegistry ?? dedupeRegistry;

  if (
    env.maxConcurrentRuns !== undefined &&
    !admitRun(env.maxConcurrentRuns, activeRunIds().length)
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
  if (opts?.dedupeKey !== undefined) registry.claim(opts.dedupeKey, childRunId);

  void (async () => {
    try {
      await startTrackedRun(runtime, db, child, {
        runId: childRunId,
        ...(env.workspace !== undefined ? { workspace: env.workspace } : {}),
        ...(env.repo !== undefined ? { repo: env.repo } : {}),
        ...(env.maxConcurrentRuns !== undefined
          ? { maxConcurrentRuns: env.maxConcurrentRuns }
          : {}),
        input,
        parentRunId,
        dispatchEnv: env,
        ...(opts?.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
        ...(opts?.dedupeKey !== undefined ? { dedupeKeyClaimed: true } : {}),
        ...(env.dedupeRegistry !== undefined ? { dedupeRegistry: env.dedupeRegistry } : {}),
      });
    } catch (err) {
      if (opts?.dedupeKey !== undefined) {
        (env.dedupeRegistry ?? dedupeRegistry).release(opts.dedupeKey, childRunId);
      }
      console.error(
        `nested run start failed (parent ${parentRunId}, child ${childRunId}):` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  return childRunId;
}

export async function startTrackedRun(
  runtime: ManagedRuntime.ManagedRuntime<AgentRuntime, never>,
  db: Database,
  workflow: WorkflowDefinition<any, any>,
  options: StartTrackedRunOptions,
): Promise<string> {
  const runId = options.runId ?? `run-${crypto.randomUUID()}`;

  const existing = active.get(runId);
  if (existing !== undefined && !isReserved(existing)) {
    throw new Error(`run ${runId} is already active`);
  }

  const registry = options.dedupeRegistry ?? dedupeRegistry;
  if (options.dedupeKey !== undefined && options.dedupeKeyClaimed !== true) {
    registry.claim(options.dedupeKey, runId);
  }
  if (existing === undefined && options.maxConcurrentRuns !== undefined) {
    if (!admitRun(options.maxConcurrentRuns, active.size)) {
      throw new ConcurrencyLimitError(options.maxConcurrentRuns);
    }
    active.set(runId, { cancelled: false });
  }

  try {
    if (options.beforeStart !== undefined) {
      await options.beforeStart();
    }

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
            workspaceRoot: options.workspace.workspaceRoot,
            sshUrl: options.workspace.sshUrl,
            identity: options.workspace.identity,
            retainedWorkspaces: options.workspace.retainedWorkspaces,
            kind,
            ...(scratchEntries !== undefined ? { scratchEntries } : {}),
            protectedEntries: [runId, ...activeRunIds()],
          }));

    if (dir === undefined) throw new Error("startTrackedRun needs `dir` or `workspace`");

    const workspaceAllocated = options.dir === undefined;

    const dispatch: DispatchChildFn | undefined =
      options.dispatchEnv === undefined
        ? undefined
        : (child, input, opts) =>
            dispatchChildRun(runtime, db, options.dispatchEnv!, runId, child, input, opts);

    const handle = await startRun(workflow, runtime, {
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
        publish(runId, event);
      },
    });

    const beforeStartEntry = active.get(runId);
    const reservedSlot = isReserved(beforeStartEntry)
      ? (beforeStartEntry as ReservedSlot)
      : undefined;
    const cancelRequested = reservedSlot?.cancelled === true;
    active.set(runId, handle);

    void handle.result.finally(() => {
      if (active.get(runId) === handle) active.delete(runId);
      if (options.dedupeKey !== undefined) registry.release(options.dedupeKey, runId);
    });

    void handle.result.then((outcome) => {
      if (workspaceAllocated && kind === "scratch" && outcome.outcome === "completed") {
        void rm(dir, { recursive: true, force: true });
      }
    });

    if (cancelRequested) void handle.cancel();

    return runId;
  } catch (err) {
    if (options.dedupeKey !== undefined) registry.release(options.dedupeKey, runId);
    const current = active.get(runId);
    if (current === undefined || isReserved(current)) active.delete(runId);
    throw err;
  }
}
