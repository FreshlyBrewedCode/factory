/**
 * The server's in-memory run registry: which runs are currently live in
 * *this* process, so the HTTP API can cancel them and the dispatcher can
 * enforce a WIP limit (D24). Deliberately not derived from sqlite — a run
 * whose process died is "interrupted" (D12), not "active"; only a `RunHandle`
 * this process actually holds counts.
 */

import type { Database } from "bun:sqlite";
import { appendEvent } from "../persistence/store";
import type { AgentAdapter } from "../runtime/agent-adapter";
import { startRun, type RunHandle } from "../runtime/run";
import type { WorkflowDefinition } from "../workflow";
import { publish } from "./pubsub";

const active = new Map<string, RunHandle<unknown>>();

export function isActive(runId: string): boolean {
  return active.has(runId);
}

export function activeRunIds(): ReadonlyArray<string> {
  return [...active.keys()];
}

export function getActiveHandle(runId: string): RunHandle<unknown> | undefined {
  return active.get(runId);
}

export interface StartTrackedRunOptions {
  readonly dir: string;
  readonly input: unknown;
  readonly adapter: AgentAdapter;
  readonly runId?: string;
}

/** Starts a run, persists+publishes every event, and tracks it until terminal. */
export function startTrackedRun(
  db: Database,
  workflow: WorkflowDefinition<any, any>,
  options: StartTrackedRunOptions,
): string {
  // crypto.randomUUID(), not `run-${Date.now()}`: the server can have more than one run start
  // within the same millisecond (concurrent HTTP POSTs, or tests running in the same process),
  // and a collided runId cross-wires the pubsub channel and `active` registry between two
  // unrelated runs — one run's SSE watcher can then see the other's terminal event and close
  // its own db while its real run is still writing to it.
  const runId = options.runId ?? `run-${crypto.randomUUID()}`;

  const handle = startRun(workflow, {
    runId,
    dir: options.dir,
    input: options.input,
    adapter: options.adapter,
    onEvent: (event) => {
      appendEvent(db, event);
      publish(runId, event);
    },
  });

  active.set(runId, handle);
  void handle.result.finally(() => active.delete(runId));

  return runId;
}
