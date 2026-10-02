/**
 * Fake `AgentAdapter`s for `bun test` (STATUS.md phase 1: "make the fake
 * adapter a corpus replayer") — the runtime code path is identical whether
 * chunks come from here or from live opencode; only this module swaps.
 *
 * ADR 0012 §2: adapters yield `AgentAdapterYield` items (opaque chunk +
 * optional signal). The corpus replay adapter extracts signals from recorded
 * opencode chunks using `extractOpencodeSignal`, so existing corpus traces
 * replay without modification. A second adapter could supply signals without
 * imitating opencode chunk shapes at all.
 *
 * `createCorpusReplayAdapter` replays a recorded NDJSON trace
 * (`test/corpus/*.ndjson`, one `{step, chunk}` line each). The traces were
 * captured one workflow step at a time, so consecutive lines sharing a
 * `step` label form one contiguous block (verified against every corpus file
 * before writing this: no interleaving). `.stream()` hands out blocks in
 * file order, one per call — a workflow's Nth `ctx.agent()` call replays the
 * Nth recorded step, independent of what the corpus happened to name it.
 */

import { readFileSync } from "node:fs";
import type {
  AgentAdapter,
  AgentAdapterOptions,
  AgentAdapterYield,
} from "../runtime/agent-adapter";
import { extractOpencodeSignal } from "../runtime/opencode-adapter";

export interface CorpusStepBlock {
  readonly step: string;
  readonly chunks: ReadonlyArray<unknown>;
}

interface CorpusLine {
  readonly step: string;
  readonly chunk: unknown;
}

export function loadCorpusBlocks(path: string): ReadonlyArray<CorpusStepBlock> {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CorpusLine);

  const blocks: Array<{ step: string; chunks: Array<unknown> }> = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    if (last !== undefined && last.step === line.step) {
      last.chunks.push(line.chunk);
    } else {
      blocks.push({ step: line.step, chunks: [line.chunk] });
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
    async prepareWorkspace(_dir: string): Promise<void> {},

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
          for (const chunk of block.chunks) {
            const signal = extractOpencodeSignal(chunk);
            yield signal !== undefined ? { chunk, signal } : { chunk };
          }
        },
      };
    },
  };
}

/**
 * A synthetic adapter that yields fixed chunks with a real delay between
 * each — slow enough that a test can call `handle.cancel()` after the first
 * chunk arrives and reliably interrupt mid-stream. Used by the cancellation
 * regression test in place of a corpus (no recorded trace can be paused on
 * demand; a corpus is a fixed sequence, not a controllable one).
 */
export function createSlowFakeAdapter(chunks: ReadonlyArray<unknown>, delayMs = 20): AgentAdapter {
  return {
    async prepareWorkspace(_dir: string): Promise<void> {},

    stream(_options: AgentAdapterOptions): AsyncIterable<AgentAdapterYield> {
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            yield { chunk };
          }
        },
      };
    },
  };
}
