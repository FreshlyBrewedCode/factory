/**
 * Pins the runtime side of the adapter seam (ADR 0012 §2): normalized signals
 * arrive from the adapter, the runtime records them, and it never interprets
 * a vendor chunk name itself. Chunks stay opaque and ride through verbatim.
 */

import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import type { AgentAdapter, AgentAdapterOptions, AgentStreamItem } from "./agent-adapter";
import { buildAgentStepEffect } from "./agent-step";

function scriptedAdapter(items: ReadonlyArray<AgentStreamItem>): AgentAdapter {
  return {
    stream(_options: AgentAdapterOptions): AsyncIterable<AgentStreamItem> {
      return (async function* () {
        yield* items;
      })();
    },
  };
}

const TEXT_CHUNKS = [
  { type: "TEXT_MESSAGE_START", messageId: "m1" },
  { type: "TEXT_MESSAGE_CONTENT", delta: "hello" },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
];

describe("buildAgentStepEffect over the signal seam (ADR 0012 §2)", () => {
  test("records adapter signals; chunks reach onChunk verbatim", async () => {
    const seen: Array<unknown> = [];
    const items: ReadonlyArray<AgentStreamItem> = [
      { chunk: { type: "RUN_STARTED" } },
      {
        chunk: { type: "CUSTOM", name: "vendor.session", value: { id: "ses_x" } },
        signal: { kind: "session", sessionId: "ses_x" },
      },
      ...TEXT_CHUNKS.map((chunk) => ({ chunk })),
      {
        chunk: { type: "CUSTOM", name: "vendor.output", value: { object: { answer: 42 } } },
        signal: { kind: "structured-output", value: { answer: 42 } },
      },
      { chunk: { type: "RUN_FINISHED" } },
    ];

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      adapter: scriptedAdapter(items),
      onChunk: (chunk) => seen.push(chunk),
    });

    const outcome = await Effect.runPromise(handle.effect);
    expect(outcome.chunkCount).toBe(7);
    expect(outcome.sessionId).toBe("ses_x");
    expect(outcome.structuredOutput).toEqual({ answer: 42 });
    expect(outcome.finalText).toBe("hello");
    expect(outcome.runError).toBeUndefined();
    expect(seen).toEqual(items.map((item) => item.chunk));
  });

  test("an error signal surfaces as runError", async () => {
    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      adapter: scriptedAdapter([
        {
          chunk: { type: "RUN_ERROR", message: "boom" },
          signal: { kind: "error", message: "boom" },
        },
      ]),
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(handle.effect);
    expect(outcome.chunkCount).toBe(1);
    expect(outcome.runError).toBe("boom");
  });

  test("the runtime records signals, it does not interpret vendor chunk names", async () => {
    // A raw CUSTOM chunk with no signal attached is opaque bookkeeping now.
    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      model: "m",
      prompt: "p",
      adapter: scriptedAdapter([
        { chunk: { type: "CUSTOM", name: "vendor.session", value: { sessionId: "ses_raw" } } },
      ]),
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(handle.effect);
    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.structuredOutput).toBeUndefined();
  });
});
