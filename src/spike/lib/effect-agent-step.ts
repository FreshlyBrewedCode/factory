/**
 * 0b: the Effect v4 <-> TanStack AI boundary spike. This is the
 * Effect-wrapped sibling of `lib/agent-step.ts` (that file is unmodified —
 * this is a new module alongside it, not a replacement, per D13's seam:
 * this is runtime/lib-layer code, not something a workflow script author
 * would write directly). Same `chat()` + `withSandbox(localProcessSandbox)`
 * + `opencodeText` plumbing and the same D14 "dump every raw chunk to
 * NDJSON" behavior, but:
 *
 * 1. The chunk stream is exposed as an Effect `Stream` via
 *    `Stream.fromAsyncIterable`, not a bare `for await`.
 * 2. Fiber interruption is bridged to the adapter's explicit cancel — the
 *    actual point of this file.
 *
 * WHY BRIDGING IS NEEDED (F4, docs/phase0-findings.md 0a-1/0a-2): closing
 * the IO stream does not terminate the opencode process; only an explicit
 * `AbortController.abort()` does, and even that is indirect, not a direct
 * kill signal. Read directly from
 * `node_modules/@tanstack/ai-opencode/src/adapters/text.ts`:
 * `abortController.abort()` fires an `abort` event -> the adapter's
 * `onAbort` listener calls the *HTTP* `session.abort()` (best-effort,
 * swallows errors) -> the in-flight `session.prompt()` promise settles ->
 * `queue.end()`/`queue.fail()` -> the adapter's own internal `for await`
 * loop ends -> the adapter generator's `finally` block runs
 * `server.dispose()` -> `proc.kill()`. The actual process kill is three
 * hops away from `abort()`, all inside the adapter, none of it exposed to
 * this caller.
 *
 * EFFECT V4 SURPRISE WORTH FLAGGING FOR PHASE 1: `Stream.fromAsyncIterable`
 * is not a bare wrapper — read `Channel.fromAsyncIterable` in
 * `node_modules/effect/dist/Channel.js` (~line 1422). It registers its own
 * scope finalizer that calls the source iterator's `.return()` on early
 * scope closure (e.g. fiber interruption), *independent of anything this
 * file adds*. `chat()`'s returned `AsyncIterable` is an async generator
 * (see `text.ts`'s `async *chatStream`), so `.return()` on it injects a
 * return completion at its current `yield` point and *will* eventually
 * reach the adapter's `finally` block on its own — the open question
 * (resolved empirically in `effect-boundary-experiment.ts`, not assumed
 * here) is whether "eventually" is fast enough to matter, or whether the
 * generator is stuck awaiting an internal promise (e.g. the in-flight
 * `session.prompt()`) that `.return()` alone can't unstick, in which case
 * the explicit `abort()` poke is load-bearing.
 *
 * `interruptBehavior`:
 * - `"abort"` — wraps the run with `Effect.onInterrupt` so fiber
 *   interruption additionally calls `abortController.abort()` (the A1/A2
 *   experiment).
 * - `"none"` — no interrupt-specific finalizer is registered at all here,
 *   isolating Effect's own built-in `.return()`-calling behavior described
 *   above (the A3 control experiment).
 */

import { chat } from "@tanstack/ai";
import { opencodeText } from "@tanstack/ai-opencode";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import { Effect, Schema, Stream } from "effect";
import type { NdjsonSink } from "./ndjson";

export class AgentStepChunkError extends Schema.TaggedError<AgentStepChunkError>()(
  "AgentStepChunkError",
  { cause: Schema.Defect() },
) {}

export interface EffectAgentStepOptions {
  /** Label recorded on every NDJSON line for this step, e.g. "implement". */
  readonly step: string;
  readonly threadId: string;
  readonly clonePath: string;
  readonly model: string;
  readonly prompt: string;
  readonly sink: NdjsonSink;
  readonly outputSchema?: unknown;
  /** See module doc — "abort" wires interrupt->abort(), "none" is the A3 control. */
  readonly interruptBehavior: "abort" | "none";
  /**
   * Fired synchronously (same JS turn) every time a chunk is processed, with
   * the running count. Lets a harness outside the Effect runtime observe
   * "chunks are genuinely flowing" without needing its own Effect
   * machinery — plain mutable-object polling is safe here because
   * everything runs on the same single-threaded event loop.
   */
  readonly onChunk?: (chunkCount: number) => void;
  /**
   * Fired synchronously from inside the `Effect.onInterrupt` finalizer,
   * before `abortController.abort()` is called. This is A1's proof that the
   * finalizer actually ran — the caller can flip a flag / write a marker
   * file from here to have a checkable side effect independent of process
   * inspection. Only used when `interruptBehavior === "abort"`.
   */
  readonly onInterruptFinalizer?: () => void;
}

export interface EffectAgentStepResult {
  readonly step: string;
  readonly chunkCount: number;
  readonly chunkTypeCounts: Record<string, number>;
  readonly customEventNames: ReadonlyArray<string>;
  readonly finalAssistantText: string;
  readonly structuredOutput: unknown;
  readonly runError: string | undefined;
  readonly durationMs: number;
}

export interface EffectAgentStepHandle {
  /** Run this with `Effect.runFork` to get an interruptible `Fiber`. */
  readonly effect: Effect.Effect<EffectAgentStepResult, AgentStepChunkError>;
  /**
   * The same `AbortController` `chat()` was given. Exposed for the harness
   * to inspect `signal.aborted` independent of the Effect result (e.g. to
   * confirm "abort" behavior actually fired the abort, distinct from the
   * process having died for some other reason).
   */
  readonly abortController: AbortController;
}

/**
 * Build (but do not run) one fresh-session opencode turn against a host
 * directory via `localProcessSandbox`, as an Effect. Every chunk is
 * appended to `options.sink` verbatim as `{ step, chunk }` (D14) before any
 * inspection, mirroring `lib/agent-step.ts`.
 */
export function agentStepEffect(options: EffectAgentStepOptions): EffectAgentStepHandle {
  const sandboxDefinition = defineSandbox({
    id: "factory-spike-effect-boundary",
    provider: localProcessSandbox({ dir: options.clonePath }),
    workspace: defineWorkspace({ source: { type: "none" }, setup: [] }),
    lifecycle: { reuse: "thread", destroyOnComplete: false },
  });

  const abortController = new AbortController();

  const baseChatOptions = {
    threadId: options.threadId,
    adapter: opencodeText(options.model, { permissionMode: "acceptEdits" as const }),
    messages: [{ role: "user" as const, content: options.prompt }],
    middleware: [withSandbox(sandboxDefinition)],
    abortController,
  };

  // Same inference-narrowing note as lib/agent-step.ts: branch the call
  // itself rather than spread/ternary so each branch's `chat()` overload
  // resolves cleanly; the loop below treats every chunk as `unknown`
  // regardless.
  const iterable: AsyncIterable<unknown> =
    options.outputSchema !== undefined
      ? (chat({
          ...baseChatOptions,
          outputSchema: options.outputSchema,
          stream: true,
        } as unknown as Parameters<typeof chat>[0]) as AsyncIterable<unknown>)
      : (chat(baseChatOptions) as AsyncIterable<unknown>);

  const rawStream = Stream.fromAsyncIterable(
    iterable,
    (cause) => new AgentStepChunkError({ cause }),
  );

  // Bookkeeping mirrors lib/agent-step.ts's `for await` loop exactly, just
  // driven from `Stream.mapEffect`'s per-element callback instead. Plain
  // closure mutation (not a `Ref`) is fine: this Effect never runs
  // concurrently with itself, and the callback is always invoked on the
  // same single-threaded event loop.
  let chunkCount = 0;
  const chunkTypeCounts: Record<string, number> = {};
  const customEventNames = new Set<string>();
  let finalAssistantText = "";
  let currentMessageBuffer: string | undefined;
  let structuredOutput: unknown;
  let runError: string | undefined;

  const startedAt = Date.now();

  const processed = Stream.mapEffect(rawStream, (chunk) =>
    Effect.promise(async () => {
      chunkCount += 1;
      await options.sink.append({ step: options.step, chunk });

      const record = chunk as { type?: unknown; name?: unknown; value?: unknown };
      const typeKey =
        typeof record.type === "string"
          ? record.type === "CUSTOM" && typeof record.name === "string"
            ? `CUSTOM:${record.name}`
            : record.type
          : "UNKNOWN";
      chunkTypeCounts[typeKey] = (chunkTypeCounts[typeKey] ?? 0) + 1;

      if (record.type === "CUSTOM" && typeof record.name === "string") {
        customEventNames.add(record.name);
        if (record.name === "structured-output.complete") {
          const value = record.value as { object?: unknown } | undefined;
          structuredOutput = value?.object;
        }
      }

      if (record.type === "TEXT_MESSAGE_START") {
        currentMessageBuffer = "";
      } else if (record.type === "TEXT_MESSAGE_CONTENT") {
        const delta = (chunk as { delta?: unknown }).delta;
        if (typeof delta === "string") {
          currentMessageBuffer = (currentMessageBuffer ?? "") + delta;
        }
      } else if (record.type === "TEXT_MESSAGE_END") {
        if (currentMessageBuffer !== undefined) {
          finalAssistantText = currentMessageBuffer;
        }
        currentMessageBuffer = undefined;
      } else if (record.type === "RUN_ERROR") {
        const message = (chunk as { message?: unknown }).message;
        runError = typeof message === "string" ? message : JSON.stringify(chunk);
      }

      options.onChunk?.(chunkCount);
      return chunk;
    }),
  );

  const drain = Stream.runDrain(processed);

  // The actual boundary wiring: `Effect.onInterrupt`'s finalizer runs ONLY
  // if `drain` is interrupted (not on normal success/failure — confirmed
  // against node_modules/effect/dist/Effect.d.ts's doc comment: "Runs the
  // specified finalizer effect if this effect is interrupted"). This is
  // deliberately NOT `Effect.ensuring` (fires on every exit) and NOT
  // anything attached to the `Stream` itself (no `Stream.onInterrupt`
  // exists in this v4 RC — checked `Stream.d.ts`, only `Stream.ensuring`,
  // which has the same "fires on every exit" problem).
  const guarded: Effect.Effect<void, AgentStepChunkError> =
    options.interruptBehavior === "abort"
      ? Effect.onInterrupt(drain, () =>
          Effect.sync(() => {
            options.onInterruptFinalizer?.();
            abortController.abort();
          }),
        )
      : drain;

  const effect = Effect.map(guarded, () => ({
    step: options.step,
    chunkCount,
    chunkTypeCounts,
    customEventNames: [...customEventNames],
    finalAssistantText,
    structuredOutput,
    runError,
    durationMs: Date.now() - startedAt,
  }));

  return { effect, abortController };
}
