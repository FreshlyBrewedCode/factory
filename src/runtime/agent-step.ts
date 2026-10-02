/**
 * Runs one fresh-session agent turn as an interruptible Effect, streaming
 * through an `AgentAdapter` (the ACP runtime, or corpus replay and fakes in
 * tests — same code path either way). Adapted from the spike's
 * `effect-agent-step.ts` (ADR 0001 §5, D17); the bookkeeping surface is
 * `ctx.agent`'s granular result (ADR 0002 §2).
 *
 * ADR 0012 §2: the runtime consumes `AgentSignal`s from the adapter and never
 * string-matches vendor event names. AG-UI standard types (`TEXT_MESSAGE_*`,
 * `RUN_FINISHED`) are still read here for `finalText` and `usage` — they are
 * the open protocol, not an agent's.
 *
 * CANCEL: the step's `AbortController` is the adapter's only cancel signal.
 * The ACP adapter answers it with ACP `session/cancel`, and kills the agent
 * after a grace and in its `finally` (ADR 0013 §6); both agents settle the
 * turn as `cancelled` in milliseconds (finding 13 §5).
 *
 * WHY THE ADAPTER STREAM IS WRAPPED (`abortableIterable`, #38): interrupting
 * the step closes the stream with the async generator's `return()`, and
 * `return()` queues behind a pending `next()`. An adapter waiting on its
 * agent — the ACP adapter waiting for the next session update — would hold
 * the interrupt until the agent's next update, and the abort that would end
 * that wait fires only after the stream is closed. The wrapper ends the
 * stream the moment the step is abandoned: `next()` races the abort signal,
 * and `return()` aborts first, starts the adapter's own `return()` without
 * awaiting it, and resolves at once. The adapter's teardown (for ACP, the
 * process kill) runs in the background; `AgentStepHandle.teardown` lets the
 * caller wait for it.
 */

import { Effect, Schema, Stream } from "effect";
import type { AgentStepContext, AgentStepCost, AgentStepUsage } from "../events";
import type { AcpAgentKind } from "./acp-agents";
import type { AgentAdapterYield } from "./agent-adapter";
import { AgentRuntime } from "./agent-runtime";

/**
 * Pull the four token counts out of a `RUN_FINISHED.usage` object.
 *
 * `usage.totalTokens` is deliberately ignored: AG-UI's total is `input +
 * output` and omits the cached prefix, which dominates a coding session. See
 * `AgentStepFinished.usage` for the full account.
 */
function readUsage(value: unknown): AgentStepUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as {
    promptTokens?: unknown;
    completionTokens?: unknown;
    promptTokensDetails?: { cachedTokens?: unknown };
    completionTokensDetails?: { reasoningTokens?: unknown };
  };
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
  return {
    inputTokens: count(usage.promptTokens),
    outputTokens: count(usage.completionTokens),
    cachedInputTokens: count(usage.promptTokensDetails?.cachedTokens),
    reasoningTokens: count(usage.completionTokensDetails?.reasoningTokens),
  };
}

export class AgentStepChunkError extends Schema.TaggedError<AgentStepChunkError>()(
  "AgentStepChunkError",
  { cause: Schema.Defect() },
) {
  /** The adapter's own message, so a failed step's `error` leads with it. */
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export interface AgentStepEffectOptions {
  readonly threadId: string;
  readonly dir: string;
  readonly agent: AcpAgentKind;
  readonly model: string;
  readonly prompt: string;
  readonly outputSchema?: unknown;
  /** Fired synchronously per chunk, before any bookkeeping — the runtime's `AgentChunk` emission point. */
  readonly onChunk: (chunk: unknown) => void;
}

export interface AgentStepOutcome {
  readonly chunkCount: number;
  readonly finalText: string;
  readonly structuredOutput: unknown;
  readonly sessionId: string | undefined;
  readonly usage: AgentStepUsage | undefined;
  readonly context: AgentStepContext | undefined;
  readonly cost: AgentStepCost | undefined;
  readonly runError: string | undefined;
  readonly durationMs: number;
}

/**
 * Live-mutated for the duration of the step, so an `Effect.onInterrupt`
 * finalizer elsewhere can read the latest counts even though the underlying
 * promise/stream never truly resolves on interruption.
 */
export interface AgentStepPartial {
  chunkCount: number;
  finalText: string;
  sessionId: string | undefined;
  usage: AgentStepUsage | undefined;
  /** From the last `usage` signal (ADR 0013 §5), so a cancelled step keeps it. */
  context: AgentStepContext | undefined;
  /** The latest cost a `usage` signal carried; see `AgentStepFinished.cost`. */
  cost: AgentStepCost | undefined;
}

export interface AgentStepHandle {
  /**
   * Run this with `runtime.runFork` to get an interruptible `Fiber`. The
   * adapter is resolved from the `AgentRuntime` service when the effect runs
   * (issue #36), not threaded through the options.
   */
  readonly effect: Effect.Effect<AgentStepOutcome, AgentStepChunkError, AgentRuntime>;
  readonly abortController: AbortController;
  readonly partial: AgentStepPartial;
  /**
   * Settles once the adapter has torn its stream down after the step was
   * abandoned (for ACP, the agent process is gone) — at once when it never
   * was. The step itself does not wait for this; shutdown does.
   */
  readonly teardown: () => Promise<void>;
}

/**
 * Wrap an adapter's stream so abandoning it is immediate (see the module
 * comment): `next()` resolves `done` as soon as `abortController` aborts, and
 * `return()` aborts (unless the stream already finished), starts the inner
 * `return()` without waiting for it, and resolves at once. `teardown()`
 * settles when that inner `return()` does — i.e. when the adapter has
 * actually cleaned up — or at once if the stream was never abandoned.
 */
export function abortableIterable<T>(
  iterable: AsyncIterable<T>,
  abortController: AbortController,
): { readonly iterable: AsyncIterable<T>; readonly teardown: () => Promise<void> } {
  let teardown: Promise<void> = Promise.resolve();
  const done: IteratorReturnResult<undefined> = { done: true, value: undefined };
  const wrapped: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner = iterable[Symbol.asyncIterator]();
      const signal = abortController.signal;
      const aborted = new Promise<IteratorResult<T>>((resolve) => {
        if (signal.aborted) resolve(done);
        else signal.addEventListener("abort", () => resolve(done), { once: true });
      });
      // `innerDone`: the adapter's own stream ended — nothing to tear down.
      // `released`: we abandoned it, and its `return()` is already started.
      let innerDone = false;
      let released = false;
      const release = (): void => {
        if (innerDone || released) return;
        released = true;
        abortController.abort();
        if (inner.return !== undefined) {
          teardown = Promise.resolve(inner.return()).then(
            () => undefined,
            () => undefined,
          );
        }
      };
      return {
        next: async () => {
          if (innerDone || released || signal.aborted) {
            release();
            return done;
          }
          const result = await Promise.race([
            inner.next().then((r) => {
              if (r.done === true) innerDone = true;
              return r;
            }),
            aborted,
          ]);
          if (result.done === true) release();
          return result;
        },
        return: async () => {
          release();
          return done;
        },
      };
    },
  };
  return { iterable: wrapped, teardown: () => teardown };
}

export function buildAgentStepEffect(options: AgentStepEffectOptions): AgentStepHandle {
  const abortController = new AbortController();
  let teardown: () => Promise<void> = () => Promise.resolve();

  const rawStream = Stream.unwrap(
    Effect.map(Effect.service(AgentRuntime), ({ adapter }) => {
      const wrapped = abortableIterable(
        adapter.stream({
          threadId: options.threadId,
          dir: options.dir,
          agent: options.agent,
          model: options.model,
          prompt: options.prompt,
          outputSchema: options.outputSchema,
          abortController,
        }),
        abortController,
      );
      teardown = wrapped.teardown;
      return Stream.fromAsyncIterable(
        wrapped.iterable,
        (cause) => new AgentStepChunkError({ cause }),
      );
    }),
  );

  const partial: AgentStepPartial = {
    chunkCount: 0,
    finalText: "",
    sessionId: undefined,
    usage: undefined,
    context: undefined,
    cost: undefined,
  };
  let currentMessageBuffer: string | undefined;
  let structuredOutput: unknown;
  let runError: string | undefined;
  const startedAt = Date.now();

  // Plain closure mutation (not a `Ref`) is fine: this Effect never runs
  // concurrently with itself, and the callback always runs on the same
  // single-threaded event loop turn (mirrors the spike's finding exactly).
  const processed = Stream.mapEffect(rawStream, (yieldItem: AgentAdapterYield) =>
    Effect.sync(() => {
      partial.chunkCount += 1;
      options.onChunk(yieldItem.chunk);

      if (yieldItem.signal !== undefined) {
        switch (yieldItem.signal._tag) {
          case "sessionId":
            partial.sessionId = yieldItem.signal.value;
            break;
          case "structuredOutput":
            structuredOutput = yieldItem.signal.value;
            break;
          case "runError":
            runError = yieldItem.signal.value;
            break;
          case "usage": {
            // Last one wins. Cost is cumulative per session (one per step),
            // and Claude sends it only at a turn's end, so an update without
            // one keeps the last figure rather than erasing it.
            const { context, cost } = yieldItem.signal.value;
            partial.context = { used: context.used, size: context.size };
            if (cost !== undefined) partial.cost = { amount: cost.amount, currency: cost.currency };
            break;
          }
        }
      }

      const record = yieldItem.chunk as {
        type?: unknown;
        delta?: unknown;
        usage?: unknown;
      };

      if (record.type === "RUN_FINISHED") {
        partial.usage = readUsage(record.usage);
      }

      if (record.type === "TEXT_MESSAGE_START") {
        currentMessageBuffer = "";
      } else if (record.type === "TEXT_MESSAGE_CONTENT") {
        const delta = record.delta;
        if (typeof delta === "string") {
          currentMessageBuffer = (currentMessageBuffer ?? "") + delta;
        }
      } else if (record.type === "TEXT_MESSAGE_END") {
        if (currentMessageBuffer !== undefined) {
          partial.finalText = currentMessageBuffer;
        }
        currentMessageBuffer = undefined;
      }

      return yieldItem;
    }),
  );

  const drain = Stream.runDrain(processed);

  // `Effect.onInterrupt`'s finalizer runs ONLY if `drain` is interrupted, not
  // on normal success/failure — deliberately not `Effect.ensuring`.
  const guarded = Effect.onInterrupt(drain, () =>
    Effect.sync(() => {
      abortController.abort();
    }),
  );

  const effect = Effect.map(guarded, () => ({
    chunkCount: partial.chunkCount,
    finalText: partial.finalText,
    structuredOutput,
    sessionId: partial.sessionId,
    usage: partial.usage,
    context: partial.context,
    cost: partial.cost,
    runError,
    durationMs: Date.now() - startedAt,
  }));

  return { effect, abortController, partial, teardown: () => teardown() };
}
