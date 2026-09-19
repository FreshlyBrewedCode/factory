/**
 * Runs one fresh-session agent turn as an interruptible Effect, streaming
 * through an `AgentAdapter` (live opencode or corpus replay — same code path
 * either way). Adapted from `src/spike/lib/effect-agent-step.ts` (ADR 0001
 * §5, D17): the boundary wiring is unchanged, only the chunk source and the
 * bookkeeping surface (now `ctx.agent`'s granular result, ADR 0002 §2) moved.
 *
 * ADR 0012 §2: the runtime consumes `AgentSignal`s from the adapter and never
 * string-matches vendor event names. AG-UI standard types (`TEXT_MESSAGE_*`)
 * are still interpreted here for `finalText` accumulation — these are part
 * of the open AG-UI protocol, not vendor-specific.
 *
 * WHY THE EXPLICIT `abortController.abort()` IS NEEDED (0a-1/0a-2 findings):
 * closing the IO stream does not terminate the opencode process; only an
 * explicit abort does, and even that is indirect — `abort()` fires the
 * adapter's `onAbort` listener, which calls the HTTP `session.abort()`, which
 * settles the in-flight `session.prompt()`, which ends the adapter's internal
 * loop, whose `finally` block finally kills the process. D17 keeps this
 * wiring even though `Stream.fromAsyncIterable`'s implicit `.return()` on
 * scope closure was sufficient in the tested case — cheap, never harmful,
 * covers the untested non-cooperative-abort case.
 */

import { Effect, Schema, Stream } from "effect";
import type { AgentStepUsage } from "../events";
import type { AgentAdapter, AgentAdapterYield } from "./agent-adapter";

/**
 * Pull the four token counts out of a `RUN_FINISHED.usage` object.
 *
 * `usage.totalTokens` is deliberately ignored: the opencode adapter computes it
 * as `input + output`, omitting the cached prefix that dominates a coding
 * session. See `AgentStepFinished.usage` for the full account.
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
) {}

export interface AgentStepEffectOptions {
  readonly threadId: string;
  readonly dir: string;
  readonly model: string;
  readonly prompt: string;
  readonly outputSchema?: unknown;
  readonly adapter: AgentAdapter;
  /** Fired synchronously per chunk, before any bookkeeping — the runtime's `AgentChunk` emission point. */
  readonly onChunk: (chunk: unknown) => void;
}

export interface AgentStepOutcome {
  readonly chunkCount: number;
  readonly finalText: string;
  readonly structuredOutput: unknown;
  readonly sessionId: string | undefined;
  readonly usage: AgentStepUsage | undefined;
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
}

export interface AgentStepHandle {
  /** Run this with `Effect.runFork` to get an interruptible `Fiber`. */
  readonly effect: Effect.Effect<AgentStepOutcome, AgentStepChunkError>;
  readonly abortController: AbortController;
  readonly partial: AgentStepPartial;
}

export function buildAgentStepEffect(options: AgentStepEffectOptions): AgentStepHandle {
  const abortController = new AbortController();

  const iterable = options.adapter.stream({
    threadId: options.threadId,
    dir: options.dir,
    model: options.model,
    prompt: options.prompt,
    outputSchema: options.outputSchema,
    abortController,
  });

  const rawStream = Stream.fromAsyncIterable(
    iterable,
    (cause) => new AgentStepChunkError({ cause }),
  );

  const partial: AgentStepPartial = {
    chunkCount: 0,
    finalText: "",
    sessionId: undefined,
    usage: undefined,
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
    runError,
    durationMs: Date.now() - startedAt,
  }));

  return { effect, abortController, partial };
}
