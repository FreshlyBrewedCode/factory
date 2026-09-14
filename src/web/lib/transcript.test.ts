import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent, RunEventPayload } from "../../events";
import { deriveTranscript, toTranscriptRows, type TranscriptRow } from "./transcript";

const CORPUS_DIR = join(import.meta.dir, "..", "..", "..", "test", "corpus");
const ROUND_TRIP = "run-1789308170212.ndjson";

interface CorpusLine {
  readonly step: string;
  readonly chunk: { readonly type: string; readonly [key: string]: unknown };
}

/** The same two envelope shapes `src/replay/adapter.ts` and `events.test.ts` normalise. */
function readCorpus(file: string): ReadonlyArray<CorpusLine> {
  return readFileSync(join(CORPUS_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((record) =>
      "chunk" in record
        ? (record as unknown as CorpusLine)
        : ({ step: "implement", chunk: record } as unknown as CorpusLine),
    );
}

/** Synthesise the `AgentChunk` log `deriveTranscript` consumes from a corpus. */
function corpusEvents(file: string, step: string): ReadonlyArray<RunEvent> {
  return readCorpus(file)
    .filter((line) => line.step === step)
    .map((line, seq): RunEvent => ({
      runId: "run-test",
      seq,
      ts: 1_000 + seq,
      payload: {
        _tag: "AgentChunk",
        stepId: `step:${step}`,
        chunkType: line.chunk.type,
        chunk: line.chunk,
      } as unknown as RunEventPayload,
    }));
}

function event(seq: number, payload: RunEventPayload): RunEvent {
  return { runId: "run-test", seq, ts: 1_000 + seq, payload };
}

const STEP_ID = "step:implement";
const PROMPT = "You are working in a git checkout. Do the thing.";

describe("deriveTranscript against the recorded round-trip corpus", () => {
  test("folds an agent step's chunks into ordered messages", () => {
    const transcript = deriveTranscript(corpusEvents(ROUND_TRIP, "implement"), STEP_ID);
    expect(transcript.stepId).toBe(STEP_ID);
    // One message per iteration: the prompt echo + tool calls, the edits, the close.
    expect(transcript.messages.length).toBeGreaterThan(2);
  });

  test("renders assistant text as prose, excluding the echoed prompt", () => {
    const events = corpusEvents(ROUND_TRIP, "implement");
    const echoed = readCorpus(ROUND_TRIP).find(
      (line) => line.step === "implement" && line.chunk.type === "TEXT_MESSAGE_CONTENT",
    )!.chunk.delta as string;

    const promptEvents: ReadonlyArray<RunEvent> = [
      event(0, {
        _tag: "AgentStepStarted",
        stepId: STEP_ID,
        name: "implement",
        model: "m",
        prompt: echoed,
        structured: false,
      }),
      ...events.map((e, i) => ({ ...e, seq: i + 1 })),
    ];

    const transcript = deriveTranscript(promptEvents, STEP_ID);
    const rows = toTranscriptRows(transcript.messages);
    const texts = rows
      .filter((row): row is Extract<TranscriptRow, { kind: "text" }> => row.kind === "text")
      .map((row) => row.content);

    // The header carries the prompt; the stream's echo is not a second copy.
    expect(transcript.prompt).toBe(echoed);
    expect(texts).not.toContain(echoed);
    expect(texts.some((text) => text.startsWith("Done."))).toBe(true);
  });

  test("folds reasoning into thinking parts", () => {
    const transcript = deriveTranscript(corpusEvents(ROUND_TRIP, "fix"), "step:fix");
    const thinking = toTranscriptRows(transcript.messages).filter((row) => row.kind === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking[0]!.content.length).toBeGreaterThan(100);
  });

  test("joins every tool call to its result by toolCallId, interleaving included", () => {
    const events = corpusEvents(ROUND_TRIP, "implement");
    const callIds = new Set(
      events
        .filter((e) => e.payload._tag === "AgentChunk" && e.payload.chunkType === "TOOL_CALL_START")
        .map((e) => (e.payload as unknown as { chunk: { toolCallId: string } }).chunk.toolCallId),
    );

    const rows = toTranscriptRows(deriveTranscript(events, STEP_ID).messages);
    const calls = rows.filter(
      (row): row is Extract<TranscriptRow, { kind: "tool-call" }> => row.kind === "tool-call",
    );

    expect(callIds.size).toBeGreaterThan(1);
    expect(calls.length).toBe(callIds.size);
    expect(calls.map((call) => call.toolCallId).sort()).toEqual([...callIds].sort());
    // Correlation is by id, so a result lands on its own call, not a neighbour's.
    const bash = calls.find((call) => call.name === "bash");
    expect(bash?.result).toContain("bun test");
    // Results are never their own row.
    expect(rows.some((row) => (row as { kind: string }).kind === "tool-result")).toBe(false);
  });

  test("reads structured output off the stream, not off AgentStepFinished", () => {
    const transcript = deriveTranscript(
      corpusEvents(ROUND_TRIP, "pr-metadata"),
      "step:pr-metadata",
    );
    const structured = toTranscriptRows(transcript.messages).filter(
      (row) => row.kind === "structured-output",
    );
    expect(structured).toHaveLength(1);
    expect(structured[0]!.status).toBe("complete");
    expect(structured[0]!.data).toMatchObject({ title: expect.any(String) });
  });
});

describe("deriveTranscript without a corpus", () => {
  test("a step with no chunks yields a header and no messages", () => {
    const transcript = deriveTranscript(
      [
        event(0, {
          _tag: "AgentStepStarted",
          stepId: "step-empty",
          name: "empty",
          model: "m",
          prompt: PROMPT,
          structured: false,
        }),
      ],
      "step-empty",
    );
    expect(transcript.prompt).toBe(PROMPT);
    expect(transcript.messages).toEqual([]);
  });

  test("chunks for one step never leak into another", () => {
    const events: ReadonlyArray<RunEvent> = [
      event(0, {
        _tag: "AgentChunk",
        stepId: "step-a",
        chunkType: "TEXT_MESSAGE_START",
        chunk: { type: "TEXT_MESSAGE_START", messageId: "m1" },
      }),
      event(1, {
        _tag: "AgentChunk",
        stepId: "step-a",
        chunkType: "TEXT_MESSAGE_CONTENT",
        chunk: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "alpha" },
      }),
      event(2, {
        _tag: "AgentChunk",
        stepId: "step-a",
        chunkType: "TEXT_MESSAGE_END",
        chunk: { type: "TEXT_MESSAGE_END", messageId: "m1" },
      }),
      event(3, {
        _tag: "AgentChunk",
        stepId: "step-b",
        chunkType: "TEXT_MESSAGE_START",
        chunk: { type: "TEXT_MESSAGE_START", messageId: "m2" },
      }),
      event(4, {
        _tag: "AgentChunk",
        stepId: "step-b",
        chunkType: "TEXT_MESSAGE_CONTENT",
        chunk: { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "beta" },
      }),
      event(5, {
        _tag: "AgentChunk",
        stepId: "step-b",
        chunkType: "TEXT_MESSAGE_END",
        chunk: { type: "TEXT_MESSAGE_END", messageId: "m2" },
      }),
    ];

    const rowsA = toTranscriptRows(deriveTranscript(events, "step-a").messages);
    const rowsB = toTranscriptRows(deriveTranscript(events, "step-b").messages);
    expect(rowsA.map((row) => (row.kind === "text" ? row.content : row.kind))).toEqual(["alpha"]);
    expect(rowsB.map((row) => (row.kind === "text" ? row.content : row.kind))).toEqual(["beta"]);
  });

  test("a leading text part equal to the prompt is dropped, not duplicated", () => {
    const messages = deriveTranscript(
      [
        event(0, {
          _tag: "AgentStepStarted",
          stepId: "s",
          name: "n",
          model: "m",
          prompt: PROMPT,
          structured: false,
        }),
        event(1, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TEXT_MESSAGE_START",
          chunk: { type: "TEXT_MESSAGE_START", messageId: "m1" },
        }),
        event(2, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TEXT_MESSAGE_CONTENT",
          chunk: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: PROMPT },
        }),
        event(3, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TEXT_MESSAGE_END",
          chunk: { type: "TEXT_MESSAGE_END", messageId: "m1" },
        }),
      ],
      "s",
    ).messages;

    // The echoed prompt was the only content, so the message is gone entirely.
    expect(messages).toEqual([]);
  });

  test("a leading prompt echo is dropped but later parts in the same message survive", () => {
    const transcript = deriveTranscript(
      [
        event(0, {
          _tag: "AgentStepStarted",
          stepId: "s",
          name: "n",
          model: "m",
          prompt: PROMPT,
          structured: false,
        }),
        event(1, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TEXT_MESSAGE_START",
          chunk: { type: "TEXT_MESSAGE_START", messageId: "m1" },
        }),
        event(2, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TEXT_MESSAGE_CONTENT",
          chunk: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: PROMPT },
        }),
        event(3, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TEXT_MESSAGE_END",
          chunk: { type: "TEXT_MESSAGE_END", messageId: "m1" },
        }),
        event(4, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TOOL_CALL_START",
          chunk: { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "read" },
        }),
        event(5, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TOOL_CALL_ARGS",
          chunk: { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"path":"a.ts"}' },
        }),
        event(6, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TOOL_CALL_END",
          chunk: { type: "TOOL_CALL_END", toolCallId: "c1" },
        }),
        event(7, {
          _tag: "AgentChunk",
          stepId: "s",
          chunkType: "TOOL_CALL_RESULT",
          chunk: { type: "TOOL_CALL_RESULT", toolCallId: "c1", content: "file body" },
        }),
      ],
      "s",
    );

    expect(transcript.messages).toHaveLength(1);
    const rows = toTranscriptRows(transcript.messages);
    expect(rows).toEqual([
      {
        kind: "tool-call",
        toolCallId: "c1",
        name: "read",
        args: '{"path":"a.ts"}',
        state: "complete",
        result: "file body",
        isError: false,
      },
    ]);
  });

  test("a prompt header with no stream produces no rows", () => {
    expect(toTranscriptRows([])).toEqual([]);
  });
});
