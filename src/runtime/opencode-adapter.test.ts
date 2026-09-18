/**
 * Pins ADR 0012 §2 on the live adapter's side: `opencodeAdapter` interprets
 * its own chunk stream and emits normalized signals — the vendor CUSTOM event
 * names (`opencode.session-id`, `structured-output.complete`) are this
 * adapter's implementation detail and appear nowhere else.
 *
 * The interpreter is exercised directly with the chunk shapes the corpus
 * recorded from the real stream, so no live opencode process or network is
 * involved.
 */

import { describe, expect, test } from "bun:test";
import type { AgentAdapter } from "./agent-adapter";
import { interpretOpencodeChunk, opencodeAdapter } from "./opencode-adapter";

function signalOf(chunk: unknown): ReturnType<typeof interpretOpencodeChunk>["signal"] {
  return interpretOpencodeChunk(chunk).signal;
}

describe("opencodeAdapter signal interpretation (ADR 0012 §2)", () => {
  test("maps opencode.session-id CUSTOM chunk to a session signal", () => {
    expect(
      signalOf({
        type: "CUSTOM",
        timestamp: 1,
        name: "opencode.session-id",
        value: { sessionId: "ses_abc" },
      }),
    ).toEqual({ kind: "session", sessionId: "ses_abc" });
  });

  test("maps structured-output.complete CUSTOM chunk to a structured-output signal", () => {
    expect(
      signalOf({
        type: "CUSTOM",
        name: "structured-output.complete",
        value: { object: { title: "t" }, raw: '{"title":"t"}' },
      }),
    ).toEqual({ kind: "structured-output", value: { title: "t" } });
  });

  test("maps RUN_ERROR to an error signal", () => {
    expect(signalOf({ type: "RUN_ERROR", message: "model exploded" })).toEqual({
      kind: "error",
      message: "model exploded",
    });
  });

  test("a RUN_ERROR without a string message stringifies the chunk", () => {
    const chunk = { type: "RUN_ERROR", code: 7 };
    expect(signalOf(chunk)).toEqual({ kind: "error", message: JSON.stringify(chunk) });
  });

  test("non-signal chunks yield no signal", () => {
    expect(signalOf({ type: "TEXT_MESSAGE_START" })).toBeUndefined();
    expect(signalOf({ type: "CUSTOM", name: "unrelated.event", value: {} })).toBeUndefined();
    expect(signalOf({ type: "CUSTOM" })).toBeUndefined();
  });

  test("the item keeps the chunk verbatim alongside the signal", () => {
    const chunk = {
      type: "CUSTOM",
      name: "opencode.session-id",
      value: { sessionId: "ses_abc" },
    };
    expect(interpretOpencodeChunk(chunk)).toEqual({
      chunk,
      signal: { kind: "session", sessionId: "ses_abc" },
    });
  });

  test("the live adapter is an AgentAdapter", () => {
    const asAdapter: AgentAdapter = opencodeAdapter;
    expect(typeof asAdapter.stream).toBe("function");
  });
});
