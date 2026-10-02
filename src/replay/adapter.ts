/**
 * Fake `AgentAdapter`s for `bun test` (STATUS.md phase 1: "make the fake
 * adapter a corpus replayer") — the runtime code path is identical whether
 * chunks come from here or from a live agent; only this module swaps.
 *
 * `createCorpusReplayAdapter` replays a recorded NDJSON trace
 * (`test/corpus/*.ndjson`). A line is `{step, chunk, signal?}`: the step's
 * name, the opaque AG-UI chunk, and the `AgentSignal` the live adapter
 * attached to it (ADR 0012 §2). The signal is recorded rather than re-derived
 * from the chunk, so replay knows no agent's event names, and a trace from
 * any adapter replays the same way. `recordingAdapter` writes the shape;
 * `scripts/record-corpus.ts` records the ACP corpora with it.
 *
 * Traces recorded before ADR 0013 (the opencode adapter's) carry no `signal`
 * and replay as chunks only: no session id, and structured output only by
 * the runtime's tier-2 re-parse. They stay for the tests about old logs.
 *
 * Consecutive lines sharing a `step` label form one contiguous block (a
 * recording is made one workflow step at a time). `.stream()` hands out
 * blocks in file order, one per call — a workflow's Nth `ctx.agent()` call
 * replays the Nth recorded step, independent of what the corpus named it.
 */

import { readFileSync } from "node:fs";
import type {
  AgentAdapter,
  AgentAdapterOptions,
  AgentAdapterYield,
  AgentSignal,
} from "../runtime/agent-adapter";
import type { AgentRuntimeConfig } from "../runtime/agent-runtime";

export interface CorpusStepBlock {
  readonly step: string;
  readonly chunks: ReadonlyArray<unknown>;
  /** The recorded items, chunk and signal; `chunks` is their chunks. */
  readonly yields: ReadonlyArray<AgentAdapterYield>;
}

/** One line of a corpus file. */
export interface CorpusLine {
  readonly step: string;
  readonly chunk: unknown;
  readonly signal?: AgentSignal;
}

export function loadCorpusBlocks(path: string): ReadonlyArray<CorpusStepBlock> {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CorpusLine);

  const blocks: Array<{ step: string; chunks: Array<unknown>; yields: Array<AgentAdapterYield> }> =
    [];
  for (const line of lines) {
    const item: AgentAdapterYield =
      line.signal !== undefined
        ? { chunk: line.chunk, signal: line.signal }
        : { chunk: line.chunk };
    const last = blocks.at(-1);
    if (last !== undefined && last.step === line.step) {
      last.chunks.push(line.chunk);
      last.yields.push(item);
    } else {
      blocks.push({ step: line.step, chunks: [line.chunk], yields: [item] });
    }
  }
  return blocks;
}

/**
 * Consumes recorded step blocks sequentially, one per `.stream()` call.
 * Throws once the corpus is exhausted rather than looping or going empty —
 * a workflow calling `ctx.agent()` more times than the corpus recorded is a
 * test-authoring bug, not a case to paper over.
 */
export function createCorpusReplayAdapter(path: string): AgentAdapter {
  const blocks = loadCorpusBlocks(path);
  let cursor = 0;

  return {
    stream(_options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield> {
      const index = cursor;
      cursor += 1;
      const block = blocks[index];
      if (block === undefined) {
        throw new Error(
          `corpus replay exhausted: ${path} has ${blocks.length} recorded step(s), requested step ${index + 1}`,
        );
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield* block.yields;
        },
      };
    },
  };
}

/**
 * Wrap a live adapter so every item it yields is also written as a corpus
 * line, under the name of the step that is running (`step()`, read when the
 * step's stream starts). The items pass through unchanged.
 */
export function recordingAdapter(
  inner: AgentAdapter,
  step: () => string,
  write: (line: CorpusLine) => void,
): AgentAdapter {
  return {
    async *stream(options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield> {
      const name = step();
      for await (const item of inner.stream(options)) {
        write(
          item.signal !== undefined
            ? { step: name, chunk: item.chunk, signal: item.signal }
            : { step: name, chunk: item.chunk },
        );
        yield item;
      }
    },
  };
}

/**
 * A synthetic adapter that yields fixed chunks with a real delay between
 * each — slow enough that a test can call `handle.cancel()` after the first
 * chunk arrives and reliably interrupt mid-stream. Used by the cancellation
 * regression test in place of a corpus (no recorded trace can be paused on
 * demand; a corpus is a fixed sequence, not a controllable one).
 *
 * Signals can be attached declaratively by index, so a test can exercise the
 * signal path without imitating any vendor chunk shape (ADR 0012 §2).
 */
export interface AttachedSignal {
  /** The zero-based position of the chunk this signal attaches to. */
  readonly index: number;
  readonly signal: AgentSignal;
}

export function createSlowFakeAdapter(
  chunks: ReadonlyArray<unknown>,
  delayMs = 20,
  signals: ReadonlyArray<AttachedSignal> = [],
): AgentAdapter {
  const byIndex = new Map(signals.map((s) => [s.index, s.signal]));
  return {
    stream(_options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield> {
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < chunks.length; index++) {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            const signal = byIndex.get(index);
            yield signal === undefined
              ? { chunk: chunks[index] }
              : { chunk: chunks[index], signal };
          }
        },
      };
    },
  };
}

/**
 * A model for every agent, so a fake-driven step resolves without naming one
 * (ADR 0013 §2: factory always sends a model). The fakes ignore it.
 */
export const FAKE_AGENT_MODELS = { claude: "fake-model", opencode: "fake-model" } as const;

/** An agent runtime config that runs every step on `adapter`, with `FAKE_AGENT_MODELS`. */
export function fakeAgents(adapter: AgentAdapter): AgentRuntimeConfig {
  return { adapter, models: FAKE_AGENT_MODELS };
}
