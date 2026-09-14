import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { buildAgentStepEffect } from "../runtime/agent-step";
import { createCorpusReplayAdapter, createSlowFakeAdapter, loadCorpusBlocks } from "./adapter";

const FULL_ROUND_TRIP_CORPUS = `${import.meta.dir}/../../test/corpus/run-1789308170212.ndjson`;

describe("loadCorpusBlocks", () => {
  test("groups the full round-trip corpus into its three recorded steps", () => {
    const blocks = loadCorpusBlocks(FULL_ROUND_TRIP_CORPUS);
    expect(blocks.map((b) => [b.step, b.chunks.length])).toEqual([
      ["implement", 39],
      ["fix", 63],
      ["pr-metadata", 33],
    ]);
  });

  test("unwraps the {step, chunk} envelope, keeping only the chunk", () => {
    const blocks = loadCorpusBlocks(FULL_ROUND_TRIP_CORPUS);
    const first = blocks[0]!.chunks[0] as { type: string };
    expect(first.type).toBe("RUN_STARTED");
  });
});

describe("createCorpusReplayAdapter", () => {
  test("hands out recorded steps in order, one per stream() call", () => {
    const adapter = createCorpusReplayAdapter(FULL_ROUND_TRIP_CORPUS);
    const options = {
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      abortController: new AbortController(),
    };

    const step1 = adapter.stream(options);
    const step2 = adapter.stream(options);
    const step3 = adapter.stream(options);

    expect(() => adapter.stream(options)).toThrow(/exhausted/);
    // Streams are lazily consumed; grab them here just to prove they exist.
    expect(step1).toBeDefined();
    expect(step2).toBeDefined();
    expect(step3).toBeDefined();
  });

  test("replays the first step through buildAgentStepEffect end to end", async () => {
    const adapter = createCorpusReplayAdapter(FULL_ROUND_TRIP_CORPUS);
    const chunks: Array<unknown> = [];

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "opencode-go/deepseek-v4.1-flash",
      prompt: "irrelevant, replay ignores it",
      adapter,
      onChunk: (chunk) => chunks.push(chunk),
    });

    const outcome = await Effect.runPromise(handle.effect);

    expect(outcome.chunkCount).toBe(39);
    expect(chunks.length).toBe(39);
    expect(outcome.sessionId).toBe("ses_f64ec04acffeJ0tjsHSkjAEqZF");
    expect(outcome.finalText.length).toBeGreaterThan(0);
    expect(outcome.runError).toBeUndefined();
  });
});

describe("createSlowFakeAdapter", () => {
  test("yields every chunk when left uninterrupted", async () => {
    const adapter = createSlowFakeAdapter(
      [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
        { type: "TEXT_MESSAGE_END" },
      ],
      1,
    );

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      adapter,
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(handle.effect);
    expect(outcome.chunkCount).toBe(3);
    expect(outcome.finalText).toBe("hi");
  });
});
