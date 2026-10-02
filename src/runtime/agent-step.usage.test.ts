/**
 * Token accounting for an agent step, against the committed corpus.
 *
 * These pin the one thing we can fix locally about `@tanstack/ai-opencode`'s
 * usage reporting: its `RUN_FINISHED.usage.totalTokens` is `input + output` and
 * omits the cached prefix, which in a coding session is ~99% of the context.
 * We ignore that field and re-derive the total from the components, which are
 * individually correct — so these tests keep passing if upstream fixes the sum.
 *
 * What they do NOT cover is the other half of the upstream bug: only the final
 * assistant message of the step is represented at all. See
 * `AgentStepFinished.usage`.
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { agentStepContextTokens } from "../events";
import type { AgentAdapterYield } from "./agent-adapter";
import { loadCorpusBlocks } from "../replay/adapter";
import { buildAgentStepEffect } from "./agent-step";

const CORPUS = "test/corpus/run-1789308170212.ndjson";

async function runBlock(chunks: ReadonlyArray<unknown>) {
  const handle = buildAgentStepEffect({
    threadId: "thread",
    dir: ".",
    model: "model",
    prompt: "prompt",
    adapter: {
      async *stream(): AsyncGenerator<AgentAdapterYield> {
        for (const chunk of chunks) {
          yield { chunk };
        }
      },
    },
    onChunk: () => {},
  });
  return await Effect.runPromise(handle.effect);
}

describe("agent step usage", () => {
  test("splits RUN_FINISHED.usage into its four components", async () => {
    const blocks = loadCorpusBlocks(CORPUS);
    const fix = blocks.find((b) => b.step === "fix");
    expect(fix).toBeDefined();

    const outcome = await runBlock(fix!.chunks);

    // The recorded chunk is
    // {promptTokens:260, completionTokens:288, totalTokens:548,
    //  promptTokensDetails:{cachedTokens:14208},
    //  completionTokensDetails:{reasoningTokens:927}}
    expect(outcome.usage).toEqual({
      inputTokens: 260,
      outputTokens: 288,
      cachedInputTokens: 14208,
      reasoningTokens: 927,
    });
  });

  test("context total counts the cached prefix the adapter's own total drops", async () => {
    const blocks = loadCorpusBlocks(CORPUS);
    const outcome = await runBlock(blocks.find((b) => b.step === "fix")!.chunks);

    // Upstream would say 548. The cached prefix is 26x that on its own.
    expect(agentStepContextTokens(outcome.usage!)).toBe(260 + 288 + 14208);
    expect(agentStepContextTokens(outcome.usage!)).toBe(14756);
  });

  test("reasoning tokens are not folded into the context total", async () => {
    // 0a-2/finding #1: reasoning is not a subset of completion tokens, so it is
    // carried alongside for cost work and deliberately left out of the sum.
    const blocks = loadCorpusBlocks(CORPUS);
    const outcome = await runBlock(blocks.find((b) => b.step === "fix")!.chunks);

    expect(outcome.usage!.reasoningTokens).toBe(927);
    expect(agentStepContextTokens(outcome.usage!)).toBe(14756);
  });

  test("absent detail blocks read as zero, not NaN", async () => {
    const blocks = loadCorpusBlocks(CORPUS);
    // `implement` has cachedTokens but no completionTokensDetails.
    const outcome = await runBlock(blocks.find((b) => b.step === "implement")!.chunks);

    expect(outcome.usage).toEqual({
      inputTokens: 259,
      outputTokens: 33,
      cachedInputTokens: 11904,
      reasoningTokens: 0,
    });
    expect(agentStepContextTokens(outcome.usage!)).toBe(12196);
  });

  test("a step with no RUN_FINISHED reports no usage at all", async () => {
    // Rather than a zeroed struct, which would read as a real measurement of
    // nothing. A cancelled step ends mid-stream and never gets the chunk.
    const outcome = await runBlock([
      { type: "RUN_STARTED" },
      { type: "TEXT_MESSAGE_START" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "partial" },
    ]);

    expect(outcome.usage).toBeUndefined();
  });
});
