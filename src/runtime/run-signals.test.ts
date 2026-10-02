/**
 * The run-level contract behind issue #35's acceptance criteria: the adapter
 * supplies normalized signals (ADR 0012 §2), and `AgentStepFinished`'s
 * `sessionId`, `output` and `error` fields are populated from them exactly as
 * before — including the two-tier structured-output resolution (signal value
 * first, `finalText` re-parse as tier-2 fallback) and the RUN_ERROR-shaped
 * failure outcome.
 */

import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../events";
import { defineWorkflow, Schema } from "../workflow";
import { fakeAgents, createSlowFakeAdapter } from "../replay/adapter";
import { makeAgentRuntime } from "./agent-runtime";
import { startRun } from "./run";

const TEXT_CHUNKS = [
  { type: "TEXT_MESSAGE_START", messageId: "m1" },
  { type: "TEXT_MESSAGE_CONTENT", delta: '{"where":"from-final-text"}' },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
];

const SIGNAL_SCHEMA = Schema.Struct({ where: Schema.String });

function agentWorkflow(outputSchema?: Schema.Codec<any, any>) {
  return defineWorkflow("signal-e2e", {
    input: Schema.Struct({}),
    run: async (ctx) => {
      const result = await ctx.agent("step", "irrelevant, replay ignores it", {
        ...(outputSchema !== undefined ? { output: outputSchema } : {}),
      });
      return { sessionId: result.sessionId, error: result.error, output: result.output };
    },
  });
}

async function runWith(
  chunks: ReadonlyArray<unknown>,
  signals: Parameters<typeof createSlowFakeAdapter>[2],
) {
  const events: Array<RunEvent> = [];
  const runtime = makeAgentRuntime(fakeAgents(createSlowFakeAdapter(chunks, 1, signals)));
  const handle = startRun(agentWorkflow(), runtime, {
    runId: "run-signals",
    dir: "/tmp",
    input: {},
    onEvent: (event) => events.push(event),
  });
  const outcome = await handle.result;
  return { outcome, events };
}

function stepFinished(events: ReadonlyArray<RunEvent>) {
  const event = events.find((e) => e.payload._tag === "AgentStepFinished");
  if (event === undefined || event.payload._tag !== "AgentStepFinished") {
    throw new Error("no AgentStepFinished event");
  }
  return event.payload;
}

describe("signals populate AgentStepFinished as before (issue #35)", () => {
  test("a session signal lands on AgentStepFinished.sessionId", async () => {
    const { events } = await runWith(TEXT_CHUNKS, [
      { index: 0, signal: { _tag: "sessionId", value: "ses_e2e" } },
    ]);
    expect(stepFinished(events).sessionId).toBe("ses_e2e");
  });

  test("a structured-output signal is decoded into AgentStepFinished.output (tier 1)", async () => {
    const events: Array<RunEvent> = [];
    const runtime = makeAgentRuntime(
      fakeAgents(
        createSlowFakeAdapter([...TEXT_CHUNKS, { type: "CUSTOM", name: "anything-at-all" }], 1, [
          { index: 3, signal: { _tag: "structuredOutput", value: { where: "from-signal" } } },
        ]),
      ),
    );
    const handle = startRun(agentWorkflow(SIGNAL_SCHEMA), runtime, {
      runId: "run-signals-output",
      dir: "/tmp",
      input: {},
      onEvent: (event) => events.push(event),
    });
    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");

    expect(stepFinished(events).output).toEqual({ where: "from-signal" });
  });

  test("without a signal, tier 2 re-parses the final text — the fallback is unchanged", async () => {
    const events: Array<RunEvent> = [];
    const runtime = makeAgentRuntime(fakeAgents(createSlowFakeAdapter(TEXT_CHUNKS, 1)));
    const handle = startRun(agentWorkflow(SIGNAL_SCHEMA), runtime, {
      runId: "run-signals-tier2",
      dir: "/tmp",
      input: {},
      onEvent: (event) => events.push(event),
    });
    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");

    expect(stepFinished(events).output).toEqual({ where: "from-final-text" });
  });

  test("an error signal fails the step and lands on AgentStepFinished.error", async () => {
    const { outcome, events } = await runWith(
      [...TEXT_CHUNKS, { type: "RUN_FINISHED" }],
      [{ index: 3, signal: { _tag: "runError", value: "sandbox vanished" } }],
    );
    expect(outcome.outcome).toBe("failed");

    const finished = stepFinished(events);
    expect(finished.outcome).toBe("failed");
    expect(finished.error).toBe("sandbox vanished");
  });
});

describe("token usage on AgentStepFinished", () => {
  const USAGE_CHUNK = {
    type: "RUN_FINISHED",
    usage: {
      promptTokens: 120,
      completionTokens: 30,
      promptTokensDetails: { cachedTokens: 900 },
      completionTokensDetails: { reasoningTokens: 7 },
    },
  };
  const EXPECTED_USAGE = {
    inputTokens: 120,
    outputTokens: 30,
    cachedInputTokens: 900,
    reasoningTokens: 7,
  };

  test("a completed step carries the usage its RUN_FINISHED chunk reported", async () => {
    const { outcome, events } = await runWith([...TEXT_CHUNKS, USAGE_CHUNK], []);
    expect(outcome.outcome).toBe("completed");

    const finished = stepFinished(events);
    expect(finished.outcome).toBe("completed");
    expect(finished.usage).toEqual(EXPECTED_USAGE);
  });

  test("a cancelled step still carries the usage seen before cancellation", async () => {
    const events: Array<RunEvent> = [];
    let handle: ReturnType<typeof startRun> | undefined;
    // The step is cancelled right after its usage chunk lands, while the next
    // (slow) chunk is still pending.
    const runtime = makeAgentRuntime(
      fakeAgents(createSlowFakeAdapter([USAGE_CHUNK, ...TEXT_CHUNKS], 50)),
    );
    handle = startRun(agentWorkflow(), runtime, {
      runId: "run-usage-cancelled",
      dir: "/tmp",
      input: {},
      onEvent: (event) => {
        events.push(event);
        if (event.payload._tag === "AgentChunk") void handle?.cancel();
      },
    });
    const outcome = await handle.result;
    expect(outcome.outcome).toBe("cancelled");

    const finished = stepFinished(events);
    expect(finished.outcome).toBe("cancelled");
    expect(finished.usage).toEqual(EXPECTED_USAGE);
  });
});
