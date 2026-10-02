/**
 * Token accounting for an agent step, against the committed corpora.
 *
 * `usage` is `RUN_FINISHED.usage` split into its four components; AG-UI's own
 * `totalTokens` is ignored (see `readUsage`). The ACP corpus is how steps
 * record today. The legacy opencode corpus stays for `agentStepContextTokens`,
 * the context fallback for logs written before ADR 0013 §5's `context`.
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { agentStepContextTokens } from "../events";
import type { AgentAdapter, AgentAdapterYield, AgentUsage } from "./agent-adapter";
import { AgentRuntimeLayer } from "./agent-runtime";
import { fakeAgents, loadCorpusBlocks } from "../replay/adapter";
import { buildAgentStepEffect } from "./agent-step";

const ACP_CORPUS = "test/corpus/acp-claude-implement-issue.ndjson";
/** Recorded by the opencode adapter before ADR 0013. */
const LEGACY_CORPUS = "test/corpus/run-1789308170212.ndjson";

const block = (path: string, step: string) => loadCorpusBlocks(path).find((b) => b.step === step)!;

async function runBlock(chunks: ReadonlyArray<unknown>) {
  return await runYields(chunks.map((chunk) => ({ chunk })));
}

async function runYields(yields: ReadonlyArray<AgentAdapterYield>) {
  const adapter: AgentAdapter = {
    async *stream(): AsyncGenerator<AgentAdapterYield> {
      yield* yields;
    },
  };
  const handle = buildAgentStepEffect({
    threadId: "thread",
    dir: ".",
    agent: "opencode",
    model: "model",
    prompt: "prompt",
    onChunk: () => {},
  });
  return await Effect.runPromise(
    Effect.provide(handle.effect, AgentRuntimeLayer(fakeAgents(adapter))),
  );
}

describe("agent step usage", () => {
  test("splits RUN_FINISHED.usage into its four components", async () => {
    const outcome = await runYields(block(ACP_CORPUS, "fix").yields);

    // The recorded chunk is
    // {promptTokens:18, completionTokens:1580, totalTokens:43492,
    //  promptTokensDetails:{cachedTokens:36982}}
    expect(outcome.usage).toEqual({
      inputTokens: 18,
      outputTokens: 1580,
      cachedInputTokens: 36982,
      reasoningTokens: 0,
    });
  });

  test("a legacy opencode step's reasoning tokens are read too", async () => {
    const outcome = await runBlock(block(LEGACY_CORPUS, "fix").chunks);

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

  test("the legacy context total counts the cached prefix opencode's own total dropped", async () => {
    const outcome = await runBlock(block(LEGACY_CORPUS, "fix").chunks);

    // opencode said 548. The cached prefix is 26x that on its own.
    expect(agentStepContextTokens(outcome.usage!)).toBe(260 + 288 + 14208);
    expect(agentStepContextTokens(outcome.usage!)).toBe(14756);
  });

  test("reasoning tokens are not folded into the context total", async () => {
    // 0a-2/finding #1: reasoning is not a subset of completion tokens, so it is
    // carried alongside for cost work and deliberately left out of the sum.
    const outcome = await runBlock(block(LEGACY_CORPUS, "fix").chunks);

    expect(outcome.usage!.reasoningTokens).toBe(927);
    expect(agentStepContextTokens(outcome.usage!)).toBe(14756);
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

const usageYield = (value: AgentUsage): AgentAdapterYield => ({
  chunk: { type: "CUSTOM", name: "acp.usage", value },
  signal: { _tag: "usage", value },
});

describe("agent step context and cost (ADR 0013 §5)", () => {
  test("the last usage signal's context wins", async () => {
    const outcome = await runYields([
      { chunk: { type: "RUN_STARTED" } },
      usageYield({ context: { used: 14_874, size: 1_000_000 } }),
      usageYield({ context: { used: 15_305, size: 200_000 } }),
      { chunk: { type: "RUN_FINISHED" } },
    ]);
    expect(outcome.context).toEqual({ used: 15_305, size: 200_000 });
    expect(outcome.cost).toBeUndefined();
  });

  test("cost is the latest one reported; an update without one keeps it", async () => {
    const outcome = await runYields([
      usageYield({ context: { used: 100, size: 1000 }, cost: { amount: 0.01, currency: "USD" } }),
      usageYield({ context: { used: 200, size: 1000 }, cost: { amount: 0.04, currency: "USD" } }),
      usageYield({ context: { used: 300, size: 1000 } }),
    ]);
    expect(outcome.context).toEqual({ used: 300, size: 1000 });
    expect(outcome.cost).toEqual({ amount: 0.04, currency: "USD" });
  });

  test("a free model's 0 USD is recorded as reported", async () => {
    const outcome = await runYields([
      usageYield({
        context: { used: 14_010, size: 200_000 },
        cost: { amount: 0, currency: "USD" },
      }),
    ]);
    expect(outcome.cost).toEqual({ amount: 0, currency: "USD" });
  });

  test("a recorded ACP step keeps its last context and cost", async () => {
    const outcome = await runYields(block(ACP_CORPUS, "implement").yields);
    expect(outcome.context).toEqual({ used: 23_879, size: 200_000 });
    expect(outcome.cost).toEqual({ amount: 0.05517899999999999, currency: "USD" });
  });

  test("a legacy step, whose agent never reported usage, has neither", async () => {
    const outcome = await runBlock(block(LEGACY_CORPUS, "fix").chunks);
    expect(outcome.context).toBeUndefined();
    expect(outcome.cost).toBeUndefined();
  });
});
