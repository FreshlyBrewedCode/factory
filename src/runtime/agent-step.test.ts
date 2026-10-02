import { Effect, ManagedRuntime } from "effect";
import { describe, expect, test } from "bun:test";
import type { AgentAdapterYield, AgentSignal } from "./agent-adapter";
import { AgentRuntimeLayer } from "./agent-runtime";
import { buildAgentStepEffect } from "./agent-step";

function makeYield(chunk: unknown, signal?: AgentSignal): AgentAdapterYield {
  return signal !== undefined ? { chunk, signal } : { chunk };
}

function signalAdapter(yields: ReadonlyArray<AgentAdapterYield>) {
  return {
    async prepareWorkspace(_dir: string): Promise<void> {},
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const y of yields) yield y;
        },
      };
    },
  };
}

describe("buildAgentStepEffect signal extraction", () => {
  test("extracts sessionId from a sessionId signal", async () => {
    const adapter = signalAdapter([
      makeYield({ type: "TEXT_MESSAGE_START" }),
      makeYield({ type: "TEXT_MESSAGE_CONTENT", delta: "hello" }),
      makeYield({ type: "TEXT_MESSAGE_END" }),
      makeYield(
        // Neutral chunk: the runtime must read the signal, not the chunk shape.
        { type: "CUSTOM", name: "anything" },
        { _tag: "sessionId", value: "ses_abc" },
      ),
    ]);

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(
      Effect.provide(handle.effect, AgentRuntimeLayer(adapter)),
    );
    expect(outcome.sessionId).toBe("ses_abc");
    expect(outcome.finalText).toBe("hello");
    expect(outcome.chunkCount).toBe(4);
  });

  test("extracts structuredOutput from a structuredOutput signal", async () => {
    const outputObject = { title: "test", body: "content" };
    const adapter = signalAdapter([
      makeYield({ type: "TEXT_MESSAGE_START" }),
      makeYield({ type: "TEXT_MESSAGE_CONTENT", delta: "done" }),
      makeYield({ type: "TEXT_MESSAGE_END" }),
      makeYield(
        { type: "CUSTOM", name: "anything" },
        { _tag: "structuredOutput", value: outputObject },
      ),
    ]);

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(
      Effect.provide(handle.effect, AgentRuntimeLayer(adapter)),
    );
    expect(outcome.structuredOutput).toEqual(outputObject);
  });

  test("extracts runError from a runError signal", async () => {
    const adapter = signalAdapter([
      // No RUN_ERROR chunk: the error comes from the signal alone.
      makeYield(
        { type: "CUSTOM", name: "anything" },
        { _tag: "runError", value: "something broke" },
      ),
    ]);

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(
      Effect.provide(handle.effect, AgentRuntimeLayer(adapter)),
    );
    expect(outcome.runError).toBe("something broke");
  });

  test("onChunk receives the raw opaque chunk, not the signal wrapper", async () => {
    const rawChunk = { type: "TEXT_MESSAGE_START" };
    const adapter = signalAdapter([makeYield(rawChunk)]);

    const chunks: Array<unknown> = [];
    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      onChunk: (chunk) => chunks.push(chunk),
    });

    await Effect.runPromise(Effect.provide(handle.effect, AgentRuntimeLayer(adapter)));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(rawChunk);
  });

  test("yields without signals pass through without error", async () => {
    const adapter = signalAdapter([
      makeYield({ type: "TEXT_MESSAGE_START" }),
      makeYield({ type: "TEXT_MESSAGE_CONTENT", delta: "no signals here" }),
      makeYield({ type: "TEXT_MESSAGE_END" }),
    ]);

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(
      Effect.provide(handle.effect, AgentRuntimeLayer(adapter)),
    );
    expect(outcome.chunkCount).toBe(3);
    expect(outcome.finalText).toBe("no signals here");
    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.structuredOutput).toBeUndefined();
    expect(outcome.runError).toBeUndefined();
  });

  test("the adapter is resolved from the AgentRuntime service when the step runs (#36)", async () => {
    let streamed = 0;
    const base = signalAdapter([makeYield({ type: "TEXT_MESSAGE_START" })]);
    const adapter = {
      ...base,
      stream: () => {
        streamed += 1;
        return base.stream();
      },
    };

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      onChunk: () => {},
    });
    expect(streamed).toBe(0);

    const runtime = ManagedRuntime.make(AgentRuntimeLayer(adapter));
    const outcome = await runtime.runPromise(handle.effect);
    await runtime.dispose();
    expect(streamed).toBe(1);
    expect(outcome.chunkCount).toBe(1);
  });
});
