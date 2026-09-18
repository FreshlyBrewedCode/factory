import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { buildAgentStepEffect } from "../runtime/agent-step";
import type { AgentAdapter, AgentAdapterOptions, AgentStreamItem } from "../runtime/agent-adapter";
import { createCorpusReplayAdapter, createSlowFakeAdapter, loadCorpusBlocks } from "./adapter";

/** Drains an adapter stream to an array (for-of over async iterables is fine; this keeps types explicit). */
async function drain(stream: AsyncIterable<AgentStreamItem>): Promise<Array<AgentStreamItem>> {
  const items: Array<AgentStreamItem> = [];
  for await (const item of stream) items.push(item);
  return items;
}

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

  test("supplies signals by interpreting recorded chunks, without imitating opencode shapes", async () => {
    const adapter = createCorpusReplayAdapter(FULL_ROUND_TRIP_CORPUS);
    const options = {
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      abortController: new AbortController(),
    };

    const items = await drain(adapter.stream(options));
    const signals = items.map((item) => item.signal).filter((signal) => signal !== undefined);

    // The recorded session id surfaces as a signal, and every signal is the
    // normalized union — never a vendor event name.
    expect(signals).toContainEqual({
      kind: "session",
      sessionId: "ses_f64ec04acffeJ0tjsHSkjAEqZF",
    });
    for (const signal of signals) {
      expect(["session", "structured-output", "error"]).toContain(signal.kind);
    }

    // Chunks still ride through verbatim, one item per recorded chunk.
    expect(items.length).toBe(39);
    expect(items.every((item) => item.chunk !== undefined)).toBe(true);
  });

  test("a declarative signal-supplying adapter needs no opencode chunk shapes at all", async () => {
    // The ADR's proof: a second adapter surfaces a session id and structured
    // output through signals alone, with chunks that carry no vendor names.
    const adapter = createFakeSignalAdapter({
      sessionId: "ses_fresh",
      structuredOutput: { ok: true },
    });
    const items = await drain(
      adapter.stream({
        threadId: "t",
        dir: "/tmp",
        model: "m",
        prompt: "p",
        abortController: new AbortController(),
      }),
    );

    expect(items.map((item) => item.signal)).toEqual([
      { kind: "session", sessionId: "ses_fresh" },
      { kind: "structured-output", value: { ok: true } },
    ]);

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      adapter,
      onChunk: () => {},
    });
    const outcome = await Effect.runPromise(handle.effect);
    expect(outcome.sessionId).toBe("ses_fresh");
    expect(outcome.structuredOutput).toEqual({ ok: true });
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

  test("attaches declared signals to their chunks", async () => {
    const adapter = createSlowFakeAdapter(
      [{ type: "RUN_STARTED" }, { type: "TEXT_MESSAGE_START" }],
      1,
      [{ index: 0, signal: { kind: "session", sessionId: "ses_slow" } }],
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
    expect(outcome.chunkCount).toBe(2);
    expect(outcome.sessionId).toBe("ses_slow");
  });
});

/** Minimal stand-in for a second adapter: signals only, no vendor chunks. */
function createFakeSignalAdapter(signals: {
  sessionId?: string;
  structuredOutput?: unknown;
}): AgentAdapter {
  return {
    stream(_options: AgentAdapterOptions): AsyncIterable<AgentStreamItem> {
      return (async function* () {
        if (signals.sessionId !== undefined) {
          yield {
            chunk: { type: "RUN_STARTED" },
            signal: { kind: "session", sessionId: signals.sessionId },
          };
        }
        if (signals.structuredOutput !== undefined) {
          yield {
            chunk: { type: "RUN_FINISHED" },
            signal: { kind: "structured-output", value: signals.structuredOutput },
          };
        }
      })();
    },
  };
}
