import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { AgentRuntimeLayer } from "../runtime/agent-runtime";
import { buildAgentStepEffect } from "../runtime/agent-step";
import type { AgentAdapterYield } from "../runtime/agent-adapter";
import {
  fakeAgents,
  createCorpusReplayAdapter,
  createSlowFakeAdapter,
  loadCorpusBlocks,
  recordingAdapter,
  type CorpusLine,
} from "./adapter";

const CLAUDE_CORPUS = `${import.meta.dir}/../../test/corpus/acp-claude-implement-issue.ndjson`;
/** Recorded by the opencode adapter before ADR 0013: chunks only, no signals. */
const OPENCODE_LEGACY_CORPUS = `${import.meta.dir}/../../test/corpus/run-1789308170212.ndjson`;

const OPTIONS = {
  threadId: "t",
  dir: "/tmp",
  agent: "claude" as const,
  model: "m",
  prompt: "p",
  abortController: new AbortController(),
};

async function collect(stream: AsyncIterable<AgentAdapterYield>): Promise<AgentAdapterYield[]> {
  const yields: AgentAdapterYield[] = [];
  for await (const y of stream) yields.push(y);
  return yields;
}

describe("loadCorpusBlocks", () => {
  test("groups a recorded run into its steps, in order", () => {
    const blocks = loadCorpusBlocks(CLAUDE_CORPUS);
    expect(blocks.map((b) => [b.step, b.chunks.length])).toEqual([
      ["implement", 163],
      ["fix", 147],
      ["pr-metadata", 75],
    ]);
  });

  test("unwraps the {step, chunk, signal} envelope", () => {
    const [first] = loadCorpusBlocks(CLAUDE_CORPUS);
    expect((first!.chunks[0] as { type: string }).type).toBe("RUN_STARTED");
    expect(first!.yields[0]).toEqual({ chunk: first!.chunks[0] });
    expect(first!.yields.find((y) => y.signal !== undefined)?.signal).toEqual({
      _tag: "sessionId",
      value: "e636e9cb-ea93-4656-9dce-ef45806d72b5",
    });
  });

  test("a legacy line without a signal loads as a bare chunk", () => {
    const blocks = loadCorpusBlocks(OPENCODE_LEGACY_CORPUS);
    expect(blocks.map((b) => [b.step, b.chunks.length])).toEqual([
      ["implement", 39],
      ["fix", 63],
      ["pr-metadata", 33],
    ]);
    expect(blocks.every((b) => b.yields.every((y) => y.signal === undefined))).toBe(true);
  });
});

describe("createCorpusReplayAdapter", () => {
  test("hands out recorded steps in order, one per stream() call", () => {
    const adapter = createCorpusReplayAdapter(CLAUDE_CORPUS);
    const steps = [adapter.stream(OPTIONS), adapter.stream(OPTIONS), adapter.stream(OPTIONS)];
    expect(() => adapter.stream(OPTIONS)).toThrow(/exhausted/);
    expect(steps.every((step) => step !== undefined)).toBe(true);
  });

  test("replays the recorded signals with their chunks", async () => {
    const adapter = createCorpusReplayAdapter(CLAUDE_CORPUS);
    adapter.stream(OPTIONS);
    adapter.stream(OPTIONS);
    const yields = await collect(adapter.stream(OPTIONS));
    expect(yields.length).toBe(75);
    const structured = yields.find((y) => y.signal?._tag === "structuredOutput");
    expect((structured!.chunk as { name?: string }).name).toBe("structured-output.complete");
    expect(structured?.signal?.value).toMatchObject({ branch: "factory/issue-1-add-slugify" });
    expect(yields.filter((y) => y.signal?._tag === "usage").length).toBe(6);
  });

  test("replays the first step through buildAgentStepEffect end to end", async () => {
    const adapter = createCorpusReplayAdapter(CLAUDE_CORPUS);
    const chunks: Array<unknown> = [];

    const handle = buildAgentStepEffect({
      threadId: "t",
      dir: "/tmp",
      agent: "claude",
      model: "haiku",
      prompt: "irrelevant, replay ignores it",
      onChunk: (chunk) => chunks.push(chunk),
    });

    const outcome = await Effect.runPromise(
      Effect.provide(handle.effect, AgentRuntimeLayer(fakeAgents(adapter))),
    );

    expect(outcome.chunkCount).toBe(163);
    expect(chunks.length).toBe(163);
    expect(outcome.sessionId).toBe("e636e9cb-ea93-4656-9dce-ef45806d72b5");
    expect(outcome.context).toEqual({ used: 23_879, size: 200_000 });
    expect(outcome.cost).toEqual({ amount: 0.05517899999999999, currency: "USD" });
    expect(outcome.finalText.length).toBeGreaterThan(0);
    expect(outcome.runError).toBeUndefined();
  });
});

describe("recordingAdapter", () => {
  test("writes each item under the running step and passes it through unchanged", async () => {
    const [implement, fix] = loadCorpusBlocks(CLAUDE_CORPUS);
    const source = createCorpusReplayAdapter(CLAUDE_CORPUS);
    const lines: CorpusLine[] = [];
    let step = "implement";
    const recorder = recordingAdapter(
      source,
      () => step,
      (line) => lines.push(line),
    );

    const first = await collect(recorder.stream(OPTIONS));
    step = "fix";
    const second = await collect(recorder.stream(OPTIONS));

    expect(first).toEqual([...implement!.yields]);
    expect(second).toEqual([...fix!.yields]);
    // What it wrote loads back into the same blocks.
    const path = join(mkdtempSync(join(tmpdir(), "factory-record-test-")), "corpus.ndjson");
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
    expect(loadCorpusBlocks(path)).toEqual([implement!, fix!]);
    rmSync(dirname(path), { recursive: true, force: true });
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
      agent: "opencode",
      model: "m",
      prompt: "p",
      onChunk: () => {},
    });

    const outcome = await Effect.runPromise(
      Effect.provide(handle.effect, AgentRuntimeLayer(fakeAgents(adapter))),
    );
    expect(outcome.chunkCount).toBe(3);
    expect(outcome.finalText).toBe("hi");
  });
});
