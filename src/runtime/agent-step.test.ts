import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import type { AgentAdapterYield, AgentSignal } from "./agent-adapter";
import { buildAgentStepEffect } from "./agent-step";

function makeYield(chunk: unknown, signal?: AgentSignal): AgentAdapterYield {
  return signal !== undefined ? { chunk, signal } : { chunk };
}

function signalAdapter(yields: ReadonlyArray<AgentAdapterYield>) {
  return {
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
        { type: "CUSTOM", name: "opencode.session-id", value: { sessionId: "ses_abc" } },
        { _tag: "sessionId", value: "ses_abc" },
      ),
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
        { type: "CUSTOM", name: "structured-output.complete", value: { object: outputObject } },
        { _tag: "structuredOutput", value: outputObject },
      ),
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
    expect(outcome.structuredOutput).toEqual(outputObject);
  });

  test("extracts runError from a runError signal", async () => {
    const adapter = signalAdapter([
      makeYield(
        { type: "RUN_ERROR", message: "something broke" },
        { _tag: "runError", value: "something broke" },
      ),
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
      adapter,
      onChunk: (chunk) => chunks.push(chunk),
    });

    await Effect.runPromise(handle.effect);
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
      adapter,
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(handle.effect);
    expect(outcome.chunkCount).toBe(3);
    expect(outcome.finalText).toBe("no signals here");
    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.structuredOutput).toBeUndefined();
    expect(outcome.runError).toBeUndefined();
  });
});
