/**
 * Run orchestration: decode input, build `ctx`, run the workflow's plain
 * `async` `run()`, emit `RunEvent`s along the way (ADR 0002/0003). This is
 * the runtime side of the ownership split — the workflow never touches
 * `RunEvent`, `seq`, or the tree.
 *
 * Cancellation (D9's "never throws" does not apply to cancellation, which is
 * the run's own unwind signal, not a workflow-observable failure): `cancel()`
 * aborts a host-level `AbortController`; if an agent step is in flight, its
 * `Fiber` is interrupted, `AgentStepFinished{outcome:"cancelled"}` is emitted
 * from the step's live-mutated `partial`, and a `RunCancelledSignal` is
 * thrown to unwind the workflow's `await` chain. It is caught here, nowhere
 * else, and turns into `RunCancelled` rather than `RunFailed`.
 */

import { Cause, Effect, Exit, Fiber, Schema, SchemaParser } from "effect";
import type { RunEvent, RunEventPayload } from "../events";
import { hostExec, type ExecResult } from "../lib/exec";
import { writeBack as writeBackLib, type WriteBackResult } from "../lib/writeback";
import type {
  AgentCallOptions,
  AgentResult,
  AssertCallback,
  AssertResult,
  WorkflowCtx,
  WorkflowDefinition,
  WorkspaceKind,
  WriteBackCallOptions,
} from "../workflow";
import type { AgentAdapter } from "./agent-adapter";
import { buildAgentStepEffect } from "./agent-step";

export class RunCancelledSignal extends Error {
  constructor() {
    super("run cancelled");
    this.name = "RunCancelledSignal";
  }
}

/** Matches the spike's model (STATUS.md); overridden per-call or per-workflow. */
export const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

/**
 * The deployment-known half of write-back (D27/D32): the repo slug pushed to
 * `gh pr create` and the branch PRs open against. The runtime supplies it
 * from `factory.config.ts`; WorkflowCtx.writeBack callers never carry it.
 */
export interface RunRepo {
  readonly slug: string;
  readonly baseBranch: string;
}

export interface StartRunOptions {
  readonly runId: string;
  readonly dir: string;
  readonly input: unknown;
  readonly adapter: AgentAdapter;
  /** Write-back environment (D32). Absent, a workflow's `ctx.writeBack` fails. */
  readonly repo?: RunRepo;
  /**
   * How `dir` was provisioned (issue #13). `"clone"` is the default; a
   * scratch run differs only in `RunStarted.workspaceKind` and `ctx.writeBack`'s
   * failure message.
   */
  readonly workspaceKind?: WorkspaceKind;
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
      // fall through to tier 2 (ADR 0002 §3: manual re-parse of finalText)
    }
  }

  try {
    return decode(JSON.parse(outcome.finalText)) as O;
  } catch {
    return undefined;
  }
}

export function startRun<I, O>(
  workflow: WorkflowDefinition<I, O>,
  options: StartRunOptions,
): RunHandle<O> {
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
    const model = opts?.model ?? workflow.agent?.model ?? DEFAULT_MODEL;
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
    const handle = buildAgentStepEffect({
      threadId: options.runId,
      dir: options.dir,
      model,
      prompt,
      outputSchema,
      adapter: options.adapter,
      onChunk: (chunk) => {
        const record = chunk as { type?: unknown };
        emit({
          _tag: "AgentChunk",
          stepId,
          chunkType: typeof record.type === "string" ? record.type : "UNKNOWN",
          chunk: chunk as never,
        });
      },
    });

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

    // Scratch has nothing to push (issue #13): the failure names the workspace
    // kind, is recorded like any other write-back failure, and runs no git.
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
      const message = err instanceof Error ? err.message : String(err);
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

  const ctx: WorkflowCtx = {
    dir: options.dir,
    agent: agentImpl,
    exec: execImpl,
    assert: assertImpl,
    log: logImpl,
    writeBack: writeBackImpl,
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
    });

    try {
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
