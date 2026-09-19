import { describe, expect, test } from "bun:test";
import { extractOpencodeSignal } from "./opencode-adapter";

describe("extractOpencodeSignal", () => {
  test("returns sessionId signal for opencode.session-id CUSTOM chunk", () => {
    const chunk = {
      type: "CUSTOM",
      name: "opencode.session-id",
      value: { sessionId: "ses_abc123" },
    };
    expect(extractOpencodeSignal(chunk)).toEqual({ _tag: "sessionId", value: "ses_abc123" });
  });

  test("returns structuredOutput signal for structured-output.complete CUSTOM chunk", () => {
    const obj = { title: "t", body: "b" };
    const chunk = {
      type: "CUSTOM",
      name: "structured-output.complete",
      value: { object: obj },
    };
    expect(extractOpencodeSignal(chunk)).toEqual({ _tag: "structuredOutput", value: obj });
  });

  test("returns runError signal for RUN_ERROR chunk", () => {
    const chunk = { type: "RUN_ERROR", message: "oops" };
    expect(extractOpencodeSignal(chunk)).toEqual({ _tag: "runError", value: "oops" });
  });

  test("returns undefined for RUN_ERROR with non-string message", () => {
    const chunk = { type: "RUN_ERROR", message: 42 };
    expect(extractOpencodeSignal(chunk)).toEqual({
      _tag: "runError",
      value: JSON.stringify(chunk),
    });
  });

  test("returns undefined for a regular TEXT_MESSAGE chunk", () => {
    expect(extractOpencodeSignal({ type: "TEXT_MESSAGE_START" })).toBeUndefined();
    expect(extractOpencodeSignal({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" })).toBeUndefined();
    expect(extractOpencodeSignal({ type: "TEXT_MESSAGE_END" })).toBeUndefined();
  });

  test("returns undefined for CUSTOM chunks with other names", () => {
    expect(
      extractOpencodeSignal({ type: "CUSTOM", name: "sandbox.file", value: {} }),
    ).toBeUndefined();
  });

  test("returns undefined for structured-output.complete without value.object", () => {
    expect(
      extractOpencodeSignal({ type: "CUSTOM", name: "structured-output.complete", value: {} }),
    ).toBeUndefined();
  });

  test("returns undefined for opencode.session-id without string sessionId", () => {
    expect(
      extractOpencodeSignal({
        type: "CUSTOM",
        name: "opencode.session-id",
        value: { sessionId: 42 },
      }),
    ).toBeUndefined();
  });
});
