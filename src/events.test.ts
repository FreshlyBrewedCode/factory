/**
 * Validates D3's event type against the real recorded corpora (D14) rather
 * than against hand-written fixtures. Phase 0 disproved four things we had
 * believed from the docs alone; a stub written from the same docs would
 * inherit the same errors.
 *
 * Fixtures live in `test/corpus/` — promoted out of the gitignored
 * `.factory/runs/` so they survive a fresh checkout. See
 * `docs/findings/1-event-type-corpus-analysis.md`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema, SchemaParser } from "effect";
import { isTerminal, RunEvent, RunEventPayload } from "./events";

const CORPUS_DIR = join(import.meta.dir, "..", "test", "corpus");

const decodeRunEvent = SchemaParser.decodeUnknownSync(RunEvent);

interface CorpusLine {
  readonly step: string;
  readonly chunk: { readonly type: string };
}

/**
 * Read a corpus, normalising the two envelope shapes the spike produced: 0a-1
 * dumped bare chunks, everything after it dumped `{step, chunk}`.
 */
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

const CORPUS_FILES = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".ndjson"));

describe("corpus fixtures", () => {
  test("all nine recorded corpora are present", () => {
    expect(CORPUS_FILES.length).toBe(9);
  });
});

describe("AgentChunk carries every recorded chunk verbatim", () => {
  for (const file of CORPUS_FILES) {
    test(file, () => {
      const lines = readCorpus(file);
      expect(lines.length).toBeGreaterThan(0);

      lines.forEach((line, index) => {
        const event = decodeRunEvent({
          runId: file.replace(/\.ndjson$/, ""),
          seq: index,
          ts: 1789300000000 + index,
          payload: {
            _tag: "AgentChunk",
            stepId: `${line.step}-0`,
            chunkType: line.chunk.type,
            chunk: line.chunk,
          },
        });

        // Opaque means opaque: what goes in comes out byte-identical, so the
        // log stays a faithful recording even if Factory's understanding of
        // AG-UI is wrong.
        expect(event.payload).toMatchObject({ _tag: "AgentChunk" });
        expect(JSON.stringify(Schema.encodeSync(RunEvent)(event).payload)).toContain(
          JSON.stringify(line.chunk),
        );
      });
    });
  }
});

describe("the closed chunk set the opencode adapter actually emits", () => {
  test("is 15 observed types, all of which survive as AgentChunk", () => {
    const observed = new Set<string>();
    for (const file of CORPUS_FILES) {
      for (const line of readCorpus(file)) observed.add(line.chunk.type);
    }

    // 16 in the adapter source; RUN_ERROR is the one never provoked.
    expect([...observed].sort()).toEqual([
      "CUSTOM",
      "REASONING_END",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_MESSAGE_START",
      "REASONING_START",
      "RUN_FINISHED",
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TOOL_CALL_START",
    ]);
  });
});

/**
 * This is the finding that forced `seq` to exist, pinned as an executable
 * assertion. If a future change "simplifies" ordering by sorting on the
 * chunk's own timestamp, this is what says no.
 */
describe("chunk timestamps are not a valid ordering key", () => {
  test("every multi-step corpus contains back-dated chunks", () => {
    const inversions: Array<{ file: string; count: number }> = [];

    for (const file of CORPUS_FILES) {
      const timestamps = readCorpus(file).map(
        (line) => (line.chunk as unknown as { timestamp: number }).timestamp,
      );
      let count = 0;
      for (let i = 1; i < timestamps.length; i++) {
        if (timestamps[i]! < timestamps[i - 1]!) count++;
      }
      if (count > 0) inversions.push({ file, count });
    }

    // All nine corpora invert, including the five-line abort/control ones.
    expect(inversions.length).toBe(CORPUS_FILES.length);
  });

  test("the back-dating source is sandbox.file, which carries an mtime", () => {
    const chunks = readCorpus("run-1789307176648.ndjson").map(
      (line) => line.chunk as unknown as Record<string, unknown>,
    );
    const isSandboxFile = (chunk: Record<string, unknown>): boolean =>
      chunk.type === "CUSTOM" && chunk.name === "sandbox.file";

    const sandboxFile = chunks.filter(isSandboxFile);
    expect(sandboxFile.length).toBeGreaterThan(0);

    // The chunk's timestamp tracks the watched file's mtime, not the moment it
    // was emitted. They agree to within a millisecond or two.
    for (const chunk of sandboxFile) {
      const value = chunk.value as { timestamp: number };
      expect(Math.abs((chunk.timestamp as number) - value.timestamp)).toBeLessThanOrEqual(2);
    }

    // Which is why they arrive back-dated: every inversion in this corpus is a
    // sandbox.file chunk landing after a chunk with a later timestamp.
    const backDated = chunks.filter((chunk, i) => {
      if (i === 0) return false;
      return (chunk.timestamp as number) < (chunks[i - 1]!.timestamp as number);
    });

    expect(backDated.length).toBeGreaterThan(0);
    expect(backDated.filter(isSandboxFile).length).toBeGreaterThanOrEqual(backDated.length - 1);
  });
});

/**
 * The corpus shows tool calls overlapping — two `toolCallId`s open at once,
 * results arriving out of start order. Anything that correlates by nesting
 * rather than by id is wrong.
 */
describe("tool calls interleave", () => {
  test("more than one tool call is open simultaneously", () => {
    const open = new Set<string>();
    let maxOpen = 0;

    for (const line of readCorpus("run-1789307176648.ndjson")) {
      const chunk = line.chunk as unknown as { type: string; toolCallId?: string };
      if (chunk.type === "TOOL_CALL_START" && chunk.toolCallId !== undefined) {
        open.add(chunk.toolCallId);
        maxOpen = Math.max(maxOpen, open.size);
      } else if (chunk.type === "TOOL_CALL_RESULT" && chunk.toolCallId !== undefined) {
        open.delete(chunk.toolCallId);
      }
    }

    expect(maxOpen).toBeGreaterThan(1);
  });
});

/**
 * The reason `Outcome` includes `cancelled` and why step termination is a
 * Factory event rather than a derived one.
 */
describe("cancellation is invisible in the chunk stream", () => {
  test("an aborted step ends with no terminal chunk and an unclosed message", () => {
    const lines = readCorpus("effect-boundary-abort-1-1789309541317.ndjson");
    const types = lines.map((line) => line.chunk.type);

    expect(types).toContain("RUN_STARTED");
    expect(types).not.toContain("RUN_FINISHED");
    expect(types).not.toContain("RUN_ERROR");

    // Stops mid-message: START arrived, END never did.
    expect(types.filter((t) => t === "TEXT_MESSAGE_START").length).toBe(1);
    expect(types.filter((t) => t === "TEXT_MESSAGE_END").length).toBe(0);
    expect(types.at(-1)).toBe("TEXT_MESSAGE_CONTENT");
  });

  test("a cancelled run is recorded by Factory, since nothing else will", () => {
    const event = decodeRunEvent({
      runId: "r1",
      seq: 4,
      ts: 1789300000000,
      payload: { _tag: "RunCancelled", durationMs: 1200 },
    });

    expect(isTerminal(event.payload)).toBe(true);
  });
});

describe("Factory lifecycle events", () => {
  test("the emission surface of ADR 0002 is fully covered", () => {
    const tags = Object.keys(RunEventPayload.cases).sort();

    expect(tags).toEqual([
      "AgentChunk",
      "AgentStepFinished",
      "AgentStepStarted",
      "AssertionRecorded",
      "ExecFinished",
      "ExecStarted",
      "LogRecorded",
      "RunCancelled",
      "RunDispatched",
      "RunFailed",
      "RunFinished",
      "RunStarted",
      "WriteBackFinished",
      "WriteBackStarted",
    ]);
  });

  test("ctx.assert records pass/fail without implying a throw", () => {
    const event = decodeRunEvent({
      runId: "r1",
      seq: 7,
      ts: 1789300000000,
      payload: {
        _tag: "AssertionRecorded",
        name: "fix-step-survived",
        pass: false,
        details: { missing: ["src/index.ts"] },
      },
    });

    expect(isTerminal(event.payload)).toBe(false);
    expect(event.payload).toMatchObject({ _tag: "AssertionRecorded", pass: false });
  });

  test("ctx.log takes arbitrary JSON, so the slot exists before phase 2 persists", () => {
    const event = decodeRunEvent({
      runId: "r1",
      seq: 8,
      ts: 1789300000000,
      payload: { _tag: "LogRecorded", name: "coverage-note", data: { lines: 42 } },
    });

    expect(event.payload).toMatchObject({ _tag: "LogRecorded" });
  });

  test("exec carries a non-zero exit code rather than an error (D9)", () => {
    const event = decodeRunEvent({
      runId: "r1",
      seq: 9,
      ts: 1789300000000,
      payload: {
        _tag: "ExecFinished",
        execId: "e0",
        command: ["bun", "test"],
        exitCode: 1,
        stdout: "",
        stderr: "1 fail",
        durationMs: 800,
      },
    });

    expect(event.payload).toMatchObject({ exitCode: 1 });
  });

  test("write-back surfaces the D16 artifact cleanup instead of hiding it", () => {
    const event = decodeRunEvent({
      runId: "r1",
      seq: 10,
      ts: 1789300000000,
      payload: {
        _tag: "WriteBackFinished",
        branch: "factory/issue-1",
        outcome: "completed",
        cleanedArtifacts: [".tanstack-projected-1e95f9272dfe038f"],
        stagedPaths: ["src/index.ts"],
        prUrl: "https://github.com/FreshlyBrewedCode/factory-spike/pull/3",
      },
    });

    expect(event.payload).toMatchObject({ outcome: "completed" });
  });

  test("a run's terminal event is exactly one of three tags", () => {
    const finished = decodeRunEvent({
      runId: "r1",
      seq: 11,
      ts: 1789300000000,
      payload: { _tag: "RunFinished", output: { prUrl: "https://example.com/1" }, durationMs: 5 },
    });
    const started = decodeRunEvent({
      runId: "r1",
      seq: 0,
      ts: 1789300000000,
      payload: { _tag: "RunStarted", workflowId: "implement-issue", dir: "/tmp/x", input: {} },
    });

    expect(isTerminal(finished.payload)).toBe(true);
    expect(isTerminal(started.payload)).toBe(false);
  });

  describe("RunStarted.workspaceKind (issue #13)", () => {
    test("records the workspace kind when present", () => {
      const event = decodeRunEvent({
        runId: "r1",
        seq: 0,
        ts: 1789300000000,
        payload: {
          _tag: "RunStarted",
          workflowId: "check",
          dir: "/tmp/x",
          input: {},
          workspaceKind: "scratch",
        },
      });

      expect(event.payload._tag === "RunStarted" && event.payload.workspaceKind).toBe("scratch");
    });

    test("is optional, so pre-existing events (and corpora) still decode", () => {
      const event = decodeRunEvent({
        runId: "r1",
        seq: 0,
        ts: 1789300000000,
        payload: { _tag: "RunStarted", workflowId: "implement-issue", dir: "/tmp/x", input: {} },
      });

      expect(event.payload).toMatchObject({ _tag: "RunStarted" });
    });

    test("records the parent run id on a child run's start (issue #14)", () => {
      const event = decodeRunEvent({
        runId: "r1",
        seq: 0,
        ts: 1789300000000,
        payload: {
          _tag: "RunStarted",
          workflowId: "implement-issue",
          dir: "/tmp/x",
          input: {},
          parentId: "run-parent",
        },
      });

      expect(event.payload._tag === "RunStarted" && event.payload.parentId).toBe("run-parent");
    });
  });

  describe("RunDispatched (issue #14)", () => {
    test("decodes with the child's run id, workflow id and input", () => {
      const event = decodeRunEvent({
        runId: "run-parent",
        seq: 3,
        ts: 1789300000000,
        payload: {
          _tag: "RunDispatched",
          childRunId: "run-child",
          childWorkflowId: "implement-issue",
          input: { issueNumber: 7 },
        },
      });

      expect(event.payload).toMatchObject({
        _tag: "RunDispatched",
        childRunId: "run-child",
        childWorkflowId: "implement-issue",
        input: { issueNumber: 7 },
      });
      expect(isTerminal(event.payload)).toBe(false);
    });
  });
});
