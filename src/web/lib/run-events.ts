import type { RunEvent } from "../../events";

/**
 * S3's read-only projection of the typed event spine (`src/events.ts`) for the
 * steps list, run overview and events tab. Pure and framework-free so it is
 * unit-testable in `bun test` without a DOM. It deliberately stops at typed
 * Factory payloads — `AgentChunk` is counted, never decoded. The transcript
 * reducer is S4.
 */

export type StepStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "pass"
  | "fail"
  | "neutral";

interface StepBase {
  /** Stable list key, derived from the runtime-assigned id (never the name). */
  readonly key: string;
  readonly startedTs: number;
  readonly status: StepStatus;
  readonly name: string;
  readonly durationMs: number | undefined;
  /** Right-hand descriptor in the step row. */
  readonly descriptor: string;
}

export interface AgentStepView extends StepBase {
  readonly kind: "agent";
  readonly stepId: string;
  readonly model: string;
  readonly structured: boolean;
  readonly prompt: string;
  readonly chunkCount: number;
  readonly sessionId: string | undefined;
  readonly finalText: string | undefined;
  readonly output: unknown;
  readonly error: string | undefined;
}

export interface ExecStepView extends StepBase {
  readonly kind: "exec";
  readonly execId: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly exitCode: number | undefined;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
}

export interface AssertStepView extends StepBase {
  readonly kind: "assert";
  readonly pass: boolean;
  readonly details: unknown;
}

export interface WriteBackStepView extends StepBase {
  readonly kind: "writeback";
  readonly branch: string;
  readonly cleanedArtifacts: ReadonlyArray<string>;
  readonly stagedPaths: ReadonlyArray<string>;
  readonly prUrl: string | undefined;
  readonly error: string | undefined;
}

export interface LogStepView extends StepBase {
  readonly kind: "log";
  readonly data: unknown;
}

export type StepView =
  | AgentStepView
  | ExecStepView
  | AssertStepView
  | WriteBackStepView
  | LogStepView;

function execStatus(
  exitCode: number | undefined,
  live: boolean,
): { status: StepStatus; descriptor: string } {
  if (exitCode === undefined) {
    return live
      ? { status: "running", descriptor: "running" }
      : { status: "interrupted", descriptor: "killed mid-exec" };
  }
  return { status: exitCode === 0 ? "completed" : "failed", descriptor: `exit ${exitCode}` };
}

export interface DeriveStepsOptions {
  /**
   * Whether the run is still live in the serving process (from `RunSummary.active`).
   * A step with no completion event is `running` while live and `interrupted`
   * once the process no longer holds the run — the log alone cannot tell them
   * apart (D12: "interrupted" is derived at read time, not written).
   */
  readonly active?: boolean;
}

/**
 * Fold a run's seq-ordered events into the activity list the steps UI renders.
 * Correlation is always by the runtime id (`stepId`/`execId`) or the write-back
 * branch, never by name (ADR 0003). `AgentChunk`s are counted, not decoded.
 */
export function deriveSteps(
  events: ReadonlyArray<RunEvent>,
  options: DeriveStepsOptions = {},
): ReadonlyArray<StepView> {
  const live = options.active ?? true;
  const steps: Array<StepView> = [];
  const agentIndex = new Map<string, number>();
  const execIndex = new Map<string, number>();
  const writeBackIndex = new Map<string, number>();

  const update = (index: number | undefined, next: StepView): void => {
    if (index !== undefined) steps[index] = next;
    else steps.push(next);
  };

  for (const event of events) {
    const payload = event.payload;
    switch (payload._tag) {
      case "AgentStepStarted": {
        const step: AgentStepView = {
          kind: "agent",
          key: `agent:${payload.stepId}`,
          startedTs: event.ts,
          status: live ? "running" : "interrupted",
          name: payload.name,
          durationMs: undefined,
          descriptor: live ? "streaming" : "killed mid-step",
          stepId: payload.stepId,
          model: payload.model,
          structured: payload.structured,
          prompt: payload.prompt,
          chunkCount: 0,
          sessionId: undefined,
          finalText: undefined,
          output: undefined,
          error: undefined,
        };
        agentIndex.set(payload.stepId, steps.length);
        steps.push(step);
        break;
      }
      case "AgentChunk": {
        const index = agentIndex.get(payload.stepId);
        const current = index === undefined ? undefined : steps[index];
        if (index !== undefined && current?.kind === "agent") {
          steps[index] = { ...current, chunkCount: current.chunkCount + 1 };
        }
        break;
      }
      case "AgentStepFinished": {
        const index = agentIndex.get(payload.stepId);
        const current = index === undefined ? undefined : steps[index];
        const base = current?.kind === "agent" ? current : undefined;
        update(index, {
          kind: "agent",
          key: `agent:${payload.stepId}`,
          startedTs: base?.startedTs ?? event.ts,
          status:
            payload.outcome === "completed"
              ? "completed"
              : payload.outcome === "cancelled"
                ? "cancelled"
                : "failed",
          name: payload.name,
          durationMs: payload.durationMs,
          descriptor: `${payload.chunkCount} chunks`,
          stepId: payload.stepId,
          model: base?.model ?? "unknown",
          structured: base?.structured ?? false,
          prompt: base?.prompt ?? "",
          chunkCount: payload.chunkCount,
          sessionId: payload.sessionId,
          finalText: payload.finalText,
          output: payload.output,
          error: payload.error,
        });
        break;
      }
      case "ExecStarted": {
        const { status, descriptor } = execStatus(undefined, live);
        execIndex.set(payload.execId, steps.length);
        steps.push({
          kind: "exec",
          key: `exec:${payload.execId}`,
          startedTs: event.ts,
          status,
          name: `$ ${payload.command.join(" ")}`,
          durationMs: undefined,
          descriptor,
          execId: payload.execId,
          command: payload.command,
          cwd: payload.cwd,
          exitCode: undefined,
          stdout: undefined,
          stderr: undefined,
        });
        break;
      }
      case "ExecFinished": {
        const index = execIndex.get(payload.execId);
        const current = index === undefined ? undefined : steps[index];
        const base = current?.kind === "exec" ? current : undefined;
        const { status, descriptor } = execStatus(payload.exitCode, live);
        update(index, {
          kind: "exec",
          key: `exec:${payload.execId}`,
          startedTs: base?.startedTs ?? event.ts,
          status,
          name: `$ ${payload.command.join(" ")}`,
          durationMs: payload.durationMs,
          descriptor,
          execId: payload.execId,
          command: payload.command,
          cwd: base?.cwd ?? "",
          exitCode: payload.exitCode,
          stdout: payload.stdout,
          stderr: payload.stderr,
        });
        break;
      }
      case "AssertionRecorded": {
        steps.push({
          kind: "assert",
          key: `assert:${event.seq}`,
          startedTs: event.ts,
          status: payload.pass ? "pass" : "fail",
          name: payload.name,
          durationMs: undefined,
          descriptor: payload.pass ? "passed" : "failed",
          pass: payload.pass,
          details: payload.details,
        });
        break;
      }
      case "WriteBackStarted": {
        writeBackIndex.set(payload.branch, steps.length);
        steps.push({
          kind: "writeback",
          key: `writeback:${payload.branch}`,
          startedTs: event.ts,
          status: "running",
          name: payload.branch,
          durationMs: undefined,
          descriptor: "running",
          branch: payload.branch,
          cleanedArtifacts: [],
          stagedPaths: [],
          prUrl: undefined,
          error: undefined,
        });
        break;
      }
      case "WriteBackFinished": {
        const index = writeBackIndex.get(payload.branch);
        const current = index === undefined ? undefined : steps[index];
        const base = current?.kind === "writeback" ? current : undefined;
        const usedBranch = payload.usedBranch ?? payload.branch;
        update(index, {
          kind: "writeback",
          key: `writeback:${payload.branch}`,
          startedTs: base?.startedTs ?? event.ts,
          status:
            payload.outcome === "completed"
              ? "completed"
              : payload.outcome === "cancelled"
                ? "cancelled"
                : "failed",
          name: usedBranch,
          durationMs: undefined,
          descriptor:
            payload.prUrl !== undefined
              ? `pr #${payload.prUrl.split("/").pop() ?? ""}`
              : (payload.error ?? "no pr"),
          branch: usedBranch,
          cleanedArtifacts: payload.cleanedArtifacts,
          stagedPaths: payload.stagedPaths,
          prUrl: payload.prUrl,
          error: payload.error,
        });
        break;
      }
      case "LogRecorded": {
        steps.push({
          kind: "log",
          key: `log:${event.seq}`,
          startedTs: event.ts,
          status: "neutral",
          name: payload.name,
          durationMs: undefined,
          descriptor: "logged",
          data: payload.data,
        });
        break;
      }
      default:
        break;
    }
  }

  return steps;
}

export interface RunSession {
  readonly name: string;
  readonly sessionId: string;
}

export interface RunMeta {
  readonly workflowId: string | undefined;
  readonly dir: string | undefined;
  readonly workspaceKind: "clone" | "scratch";
  readonly input: unknown;
  readonly output: unknown;
  readonly error: string | undefined;
  readonly cancelled: boolean;
  readonly terminalTag: "RunFinished" | "RunFailed" | "RunCancelled" | undefined;
  readonly finishedAt: number | undefined;
  readonly durationMs: number | undefined;
  readonly sessions: ReadonlyArray<RunSession>;
  /** This run's parent, when it was started by `ctx.dispatch` (issue #14). */
  readonly parentId: string | undefined;
  /** The children this run dispatched via `ctx.dispatch` (issue #14). */
  readonly dispatched: ReadonlyArray<{
    readonly childRunId: string;
    readonly childWorkflowId: string;
  }>;
  /** This run's dedupe key, when it was started with one (issue #15). */
  readonly dedupeKey: string | undefined;
  /**
   * The `ctx.dispatch` calls this run attempted that lost the dedupe-key
   * race (issue #15). Visible on run detail with the holding run reachable
   * from them — a collision is never a silent no-op.
   */
  readonly collisions: ReadonlyArray<{
    readonly key: string;
    readonly holderRunId: string;
    readonly childWorkflowId: string;
  }>;
}

/** Run-overview fields that only exist in events, not in `RunSummary`. */
export function deriveRunMeta(events: ReadonlyArray<RunEvent>): RunMeta {
  let workflowId: string | undefined;
  let dir: string | undefined;
  let workspaceKind: "clone" | "scratch" = "clone";
  let input: unknown;
  let output: unknown;
  let error: string | undefined;
  let cancelled = false;
  let terminalTag: RunMeta["terminalTag"];
  let finishedAt: number | undefined;
  let durationMs: number | undefined;
  const sessions: Array<RunSession> = [];
  let parentId: string | undefined;
  const dispatched: Array<{ childRunId: string; childWorkflowId: string }> = [];
  let dedupeKey: string | undefined;
  const collisions: Array<{ key: string; holderRunId: string; childWorkflowId: string }> = [];

  for (const event of events) {
    switch (event.payload._tag) {
      case "RunStarted":
        workflowId = event.payload.workflowId;
        dir = event.payload.dir;
        input = event.payload.input;
        workspaceKind = event.payload.workspaceKind ?? "clone";
        parentId = event.payload.parentId;
        dedupeKey = event.payload.dedupeKey;
        break;
      case "DispatchCollision":
        collisions.push({
          key: event.payload.key,
          holderRunId: event.payload.holderRunId,
          childWorkflowId: event.payload.childWorkflowId,
        });
        break;
      case "RunDispatched":
        dispatched.push({
          childRunId: event.payload.childRunId,
          childWorkflowId: event.payload.childWorkflowId,
        });
        break;
      case "RunFinished":
        output = event.payload.output;
        terminalTag = "RunFinished";
        finishedAt = event.ts;
        durationMs = event.payload.durationMs;
        break;
      case "RunFailed":
        error = event.payload.message;
        terminalTag = "RunFailed";
        finishedAt = event.ts;
        durationMs = event.payload.durationMs;
        break;
      case "RunCancelled":
        cancelled = true;
        terminalTag = "RunCancelled";
        finishedAt = event.ts;
        durationMs = event.payload.durationMs;
        break;
      case "AgentStepFinished":
        if (event.payload.sessionId !== undefined) {
          sessions.push({ name: event.payload.name, sessionId: event.payload.sessionId });
        }
        break;
      default:
        break;
    }
  }

  return {
    workflowId,
    dir,
    workspaceKind,
    input,
    output,
    error,
    cancelled,
    terminalTag,
    finishedAt,
    durationMs,
    sessions,
    parentId,
    dispatched,
    dedupeKey,
    collisions,
  };
}

/** One-line human summary for the Events tab, per typed payload. */
export function summarizeEvent(event: RunEvent): string {
  const payload = event.payload;
  switch (payload._tag) {
    case "RunStarted":
      return `${payload.workflowId} · ${payload.dir}`;
    case "RunDispatched":
      return `dispatched ${payload.childWorkflowId} · ${payload.childRunId}${payload.dedupeKey !== undefined ? ` · key ${payload.dedupeKey}` : ""}`;
    case "DispatchCollision":
      return `collision · ${payload.key} held by ${payload.holderRunId}`;
    case "RunFinished":
      return `finished · ${payload.durationMs}ms`;
    case "RunFailed":
      return payload.message;
    case "RunCancelled":
      return `cancelled · ${payload.durationMs}ms`;
    case "AgentStepStarted":
      return `${payload.name} · ${payload.model}`;
    case "AgentChunk":
      return payload.chunkType;
    case "AgentStepFinished":
      return `${payload.name} · ${payload.outcome} · ${payload.chunkCount} chunks`;
    case "ExecStarted":
      return `$ ${payload.command.join(" ")}`;
    case "ExecFinished":
      return `exit ${payload.exitCode}`;
    case "AssertionRecorded":
      return `${payload.name} · ${payload.pass ? "pass" : "fail"}`;
    case "LogRecorded":
      return payload.name;
    case "WriteBackStarted":
      return payload.branch;
    case "WriteBackFinished":
      return `${payload.branch} · ${payload.outcome}${payload.prUrl !== undefined ? ` · ${payload.prUrl}` : ""}`;
    default:
      return payload satisfies never;
  }
}
