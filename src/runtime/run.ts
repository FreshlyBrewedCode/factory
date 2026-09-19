/**
 * Run orchestration: decode input, build `ctx`, run the workflow's plain
 * `async` `run()`, emit `RunEvent`s along the way (ADR 0002/0003).
 */

import { Cause, Effect, Exit, Fiber, Schema, SchemaParser } from "effect";
import type { ManagedRuntime } from "effect";
import type { RunEvent, RunEventPayload } from "../events";
import { hostExec, type ExecResult } from "../lib/exec";
import { writeBack as writeBackLib, type WriteBackResult } from "../lib/writeback";
import type {
  AgentCallOptions,
  AgentResult,
  AssertCallback,
  AssertResult,
  DispatchChildFn,
  WorkflowCtx,
  WorkflowDefinition,
  WorkspaceKind,
  WriteBackCallOptions,
} from "../workflow";
import { DedupeKeyError } from "../lib/dedupe";
import { buildAgentStepEffect } from "./agent-step";
import { AgentRuntime } from "./agent-runtime";

export class RunCancelledSignal extends Schema.TaggedError<RunCancelledSignal>()(
  "RunCancelledSignal",
  {},
) {}

/**
 * The domain errors (`DedupeKeyError`, `ConcurrencyLimitError`,
 * `DispatchCapError`) each carry their own `message` (a `Schema.TaggedError`
 * field or getter — issue #34), so this is just the generic `Error` fallback,
 * not a per-tag dispatch.
 */
function domainErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.message || String(err);
}

/** Matches the spike's model (STATUS.md); overridden per-call or per-workflow. */
export const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

export interface RunRepo {
  readonly slug: string;
  readonly baseBranch: string;
}

export interface StartRunOptions {
  readonly runId: string;
  readonly dir: string;
  readonly input: unknown;
  readonly repo?: RunRepo;
  readonly workspaceKind?: WorkspaceKind;
  /**
   * ADR 0012 §3 (#37): when true, the runtime calls `adapter.prepareWorkspace`
   * before the workflow runs. The caller sets this when it allocated a clone
   * workspace (daemon's `allocateWorkspace` or legacy `resetClone`). Absent,
   * no preparation happens (explicit caller-managed dirs, scratch).
   */
  readonly prepareWorkspace?: boolean;
  readonly dispatch?: DispatchChildFn;
  readonly parentRunId?: string;
  readonly dedupeKey?: string;
  readonly scheduleId?: string;
  readonly agentOverrides?: { readonly model?: string };
  readonly onEvent: (event: RunEvent) => void;
}

export type RunOutcome<O> =
  | { readonly outcome: "completed"; readonly output: O }
  | { readonly outcome: "failed"; readonly error: string }
  | { readonly outcome: "cancelled" };

export interface RunHandle<O> {
  readonly result: Promise<RunOutcome<O>>;
  cancel(): Promise<void>;
}

function makeIdCounter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

function resolveOutput<O>(
  outcome: { readonly structuredOutput: unknown; readonly finalText: string },
  schema: Schema.Codec<any, any> | undefined,
): O | undefined {
  if (schema === undefined) return undefined;
  const decode = SchemaParser.decodeUnknownSync(schema);
  if (outcome.structuredOutput !== undefined) {
    try {
      return decode(outcome.structuredOutput) as O;
    } catch {
      // fall through to tier 2
    }
  }
  try {
    return decode(JSON.parse(outcome.finalText)) as O;
  } catch {
    return undefined;
  }
}

export async function startRun<I, O>(
  workflow: WorkflowDefinition<I, O>,
  runtime: ManagedRuntime.ManagedRuntime<AgentRuntime, never>,
  options: StartRunOptions,
): Promise<RunHandle<O>> {
  let seq = 0;
  const emit = (payload: RunEventPayload): void => {
    options.onEvent({ runId: options.runId, seq: seq++, ts: Date.now(), payload });
  };

  const runController = new AbortController();
  let cancelled = false;
  let activeAgentFiber: Fiber.Fiber<unknown, unknown> | null = null;

  runController.signal.addEventListener("abort", () => {
    cancelled = true;
    if (activeAgentFiber !== null) {
      Effect.runFork(Fiber.interrupt(activeAgentFiber));
    }
  });

  const nextStepId = makeIdCounter("step");
  const nextExecId = makeIdCounter("exec");
  const startedAt = Date.now();
  const workspaceKind = options.workspaceKind ?? "clone";

  const execImpl = async (argv: ReadonlyArray<string>): Promise<ExecResult> => {
    if (cancelled) throw new RunCancelledSignal();
    const execId = nextExecId();
    emit({ _tag: "ExecStarted", execId, command: [...argv], cwd: options.dir });
    const stepStartedAt = Date.now();
    const result = await hostExec(argv, { cwd: options.dir, signal: runController.signal });
    const durationMs = Date.now() - stepStartedAt;
    emit({
      _tag: "ExecFinished",
      execId,
      command: [...argv],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
    });
    if (cancelled) throw new RunCancelledSignal();
    return result;
  };

  const agentImpl = async <O2 = unknown>(
    name: string,
    prompt: string,
    opts?: AgentCallOptions,
  ): Promise<AgentResult<O2>> => {
    if (cancelled) throw new RunCancelledSignal();
    const stepId = nextStepId();
    const model =
      opts?.model ?? options.agentOverrides?.model ?? workflow.agent?.model ?? DEFAULT_MODEL;
    const outputSchema =
      opts?.output !== undefined ? Schema.toJsonSchemaDocument(opts.output) : undefined;
    emit({
      _tag: "AgentStepStarted",
      stepId,
      name,
      model,
      prompt,
      structured: opts?.output !== undefined,
    });
    const stepStartedAt = Date.now();
    const handle = await runtime.runPromise(
      buildAgentStepEffect({
        threadId: options.runId,
        dir: options.dir,
        model,
        prompt,
        outputSchema,
        onChunk: (chunk) => {
          const record = chunk as { type?: unknown };
          emit({
            _tag: "AgentChunk",
            stepId,
            chunkType: typeof record.type === "string" ? record.type : "UNKNOWN",
            chunk: chunk as never,
          });
        },
      }),
    );
    const fiber = Effect.runFork(handle.effect);
    activeAgentFiber = fiber;
    const exit = await Effect.runPromise(Fiber.await(fiber));
    activeAgentFiber = null;
    const durationMs = Date.now() - stepStartedAt;
    if (Exit.isFailure(exit)) {
      const cause = exit.cause;
      const wasInterrupted = Exit.hasInterrupts(exit);
      if (wasInterrupted) {
        emit({
          _tag: "AgentStepFinished",
          stepId,
          name,
          outcome: "cancelled",
          chunkCount: handle.partial.chunkCount,
          durationMs,
          finalText: handle.partial.finalText,
          ...(handle.partial.sessionId !== undefined
            ? { sessionId: handle.partial.sessionId }
            : {}),
        });
        throw new RunCancelledSignal();
      }
      const message = Cause.pretty(cause);
      emit({
        _tag: "AgentStepFinished",
        stepId,
        name,
        outcome: "failed",
        chunkCount: handle.partial.chunkCount,
        durationMs,
        finalText: handle.partial.finalText,
        ...(handle.partial.sessionId !== undefined ? { sessionId: handle.partial.sessionId } : {}),
        error: message,
      });
      throw new Error(`agent step "${name}" failed: ${message}`);
    }
    const result = exit.value;
    const output = resolveOutput<O2>(result, opts?.output);
    const outcome = result.runError !== undefined ? "failed" : "completed";
    emit({
      _tag: "AgentStepFinished",
      stepId,
      name,
      outcome,
      chunkCount: result.chunkCount,
      durationMs,
      finalText: result.finalText,
      ...(output !== undefined ? { output: output as never } : {}),
      ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
      ...(result.runError !== undefined ? { error: result.runError } : {}),
    });
    if (outcome === "failed") {
      throw new Error(`agent step "${name}" reported RUN_ERROR: ${result.runError}`);
    }
    return {
      stepId,
      chunkCount: result.chunkCount,
      finalText: result.finalText,
      output,
      sessionId: result.sessionId,
      error: result.runError,
    };
  };

  const assertImpl = async (name: string, callback: AssertCallback): Promise<AssertResult> => {
    const raw = await callback();
    const normalized = typeof raw === "boolean" ? { pass: raw, details: undefined } : raw;
    emit({
      _tag: "AssertionRecorded",
      name,
      pass: normalized.pass,
      ...(normalized.details !== undefined ? { details: normalized.details as never } : {}),
    });
    return { name, pass: normalized.pass, details: normalized.details };
  };

  const logImpl = async (name: string, data: unknown): Promise<void> => {
    emit({ _tag: "LogRecorded", name, data: data as never });
  };

  const writeBackImpl = async (opts: WriteBackCallOptions): Promise<WriteBackResult> => {
    emit({ _tag: "WriteBackStarted", branch: opts.branch });
    if (workspaceKind === "scratch") {
      const message =
        'ctx.writeBack is not available on a scratch workspace: the workspace kind is "scratch", so there is no clone to push';
      emit({
        _tag: "WriteBackFinished",
        branch: opts.branch,
        outcome: "failed",
        cleanedArtifacts: [],
        stagedPaths: [],
        error: message,
      });
      throw new Error(message);
    }
    if (options.repo === undefined) {
      const message =
        "ctx.writeBack needs run-repo config (slug/baseBranch) — this run was started without it";
      emit({
        _tag: "WriteBackFinished",
        branch: opts.branch,
        outcome: "failed",
        cleanedArtifacts: [],
        stagedPaths: [],
        error: message,
      });
      throw new Error(message);
    }
    try {
      const result = await writeBackLib(
        {
          dir: options.dir,
          branch: opts.branch,
          baseBranch: options.repo.baseBranch,
          repoSlug: options.repo.slug,
          commitMessage: opts.commitMessage,
          prTitle: opts.prTitle,
          prBody: opts.prBody,
          runId: options.runId,
        },
        execImpl,
      );
      const outcome = result.prResult.exitCode === 0 ? "completed" : "failed";
      const failureDetail =
        result.prResult.stderr || result.pushResult.stderr || result.commitResult.stderr;
      emit({
        _tag: "WriteBackFinished",
        branch: opts.branch,
        ...(result.collided ? { usedBranch: result.branch } : {}),
        outcome,
        cleanedArtifacts: [...result.cleanedArtifacts],
        stagedPaths: [...result.stagedPaths],
        ...(result.prUrl !== null ? { prUrl: result.prUrl } : {}),
        ...(outcome === "failed" ? { error: failureDetail } : {}),
      });
      return result;
    } catch (err) {
      if (err instanceof RunCancelledSignal) throw err;
      const message = domainErrorMessage(err);
      emit({
        _tag: "WriteBackFinished",
        branch: opts.branch,
        outcome: "failed",
        cleanedArtifacts: [],
        stagedPaths: [],
        error: message,
      });
      throw err;
    }
  };

  const dispatchImpl = async (
    child: WorkflowDefinition<any, any>,
    input: unknown,
    opts?: { readonly dedupeKey?: string },
  ): Promise<string> => {
    if (options.dispatch === undefined) {
      throw new Error(
        "ctx.dispatch is only available on a daemon-managed run — start runs via the daemon " +
          "(factory serve / factory start). A workflow executed without a daemon " +
          "(in-process execution is legacy) has no registry to start a nested run from",
      );
    }
    let childRunId: string;
    try {
      childRunId = await options.dispatch(child, input, opts);
    } catch (err) {
      if (err instanceof DedupeKeyError) {
        emit({
          _tag: "DispatchCollision",
          key: err.key,
          holderRunId: err.holderRunId,
          childWorkflowId: child.id,
        });
      }
      throw err;
    }
    emit({
      _tag: "RunDispatched",
      childRunId,
      childWorkflowId: child.id,
      input: input as never,
      ...(opts?.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
    });
    return childRunId;
  };

  const ctx: WorkflowCtx = {
    dir: options.dir,
    agent: agentImpl,
    exec: execImpl,
    assert: assertImpl,
    log: logImpl,
    writeBack: writeBackImpl,
    dispatch: dispatchImpl,
  };

  const resultPromise: Promise<RunOutcome<O>> = (async (): Promise<RunOutcome<O>> => {
    let decodedInput: I;
    try {
      decodedInput = SchemaParser.decodeUnknownSync(workflow.input)(options.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ _tag: "RunFailed", message, durationMs: Date.now() - startedAt });
      return { outcome: "failed", error: message };
    }
    emit({
      _tag: "RunStarted",
      workflowId: workflow.id,
      dir: options.dir,
      input: decodedInput as never,
      workspaceKind,
      ...(options.parentRunId !== undefined ? { parentId: options.parentRunId } : {}),
      ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
      ...(options.scheduleId !== undefined ? { scheduleId: options.scheduleId } : {}),
    });
    try {
      if (options.prepareWorkspace === true) {
        const { adapter } = await runtime.runPromise(AgentRuntime);
        await adapter.prepareWorkspace(options.dir);
      }

      const output = await workflow.run(ctx, decodedInput);
      if (workflow.output !== undefined) {
        SchemaParser.decodeUnknownSync(workflow.output)(output);
      }
      const durationMs = Date.now() - startedAt;
      emit({
        _tag: "RunFinished",
        durationMs,
        ...(output !== undefined ? { output: output as never } : {}),
      });
      return { outcome: "completed", output };
    } catch (err) {
      const durationMs = Date.now() - startedAt;

      if (err instanceof RunCancelledSignal) {
        emit({ _tag: "RunCancelled", durationMs });
        return { outcome: "cancelled" };
      }
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      emit({
        _tag: "RunFailed",
        message,
        durationMs,
        ...(stack !== undefined ? { stack } : {}),
      });
      return { outcome: "failed", error: message };
    }
  })();

  return {
    result: resultPromise,
    cancel: async () => {
      runController.abort();
      await resultPromise;
    },
  };
}
