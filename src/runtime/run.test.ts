/**
 * Cancellation regression test (STATUS.md phase 1 exit criterion). Pins
 * Factory's own `RunOutcome`/`RunEvent` contract — a `cancelled` outcome and
 * an `AgentStepFinished{outcome:"cancelled"}` event — independent of
 * `Fiber`/`Exit` internals, which `run.ts` already had to work around once
 * (see its `Exit.isFailure`/`Exit.hasInterrupts` narrowing note).
 */

import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../events";
import { defineWorkflow, Schema } from "../workflow";
import { fakeAgents, createSlowFakeAdapter } from "../replay/adapter";
import { makeAgentRuntime } from "./agent-runtime";
import { startRun, RunCancelledSignal } from "./run";
import type { AgentAdapter, AgentAdapterOptions } from "./agent-adapter";

describe("RunCancelledSignal as TaggedError (#34)", () => {
  test("carries the _tag and the cancellation message", () => {
    const signal = RunCancelledSignal.of();
    expect(signal._tag).toBe("RunCancelledSignal");
    expect(signal.message).toBe("run cancelled");
    expect(signal instanceof Error).toBe(true);
  });
});

const SLOW_CHUNKS = [
  { type: "TEXT_MESSAGE_START" },
  { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
  { type: "TEXT_MESSAGE_CONTENT", delta: " there" },
  { type: "TEXT_MESSAGE_END" },
];

describe("startRun cancellation", () => {
  test("cancel() mid agent-step resolves the run as cancelled, not failed", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("cancel-test", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        await ctx.agent("slow-step", "irrelevant, replay ignores it");
        return {};
      },
    });

    const handle = startRun(
      workflow,
      makeAgentRuntime(fakeAgents(createSlowFakeAdapter(SLOW_CHUNKS, 20))),
      {
        runId: "run-cancel-test",
        dir: "/tmp",
        input: {},
        onEvent: (event) => events.push(event),
      },
    );

    // Let the first chunk or two land, then cancel while the step is still streaming.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await handle.cancel();

    const outcome = await handle.result;
    expect(outcome.outcome).toBe("cancelled");

    const stepFinished = events.find((e) => e.payload._tag === "AgentStepFinished");
    expect(stepFinished).toBeDefined();
    expect(stepFinished?.payload).toMatchObject({ outcome: "cancelled" });

    const runCancelled = events.find((e) => e.payload._tag === "RunCancelled");
    expect(runCancelled).toBeDefined();

    const runFailed = events.find((e) => e.payload._tag === "RunFailed");
    expect(runFailed).toBeUndefined();
  });

  test("a cancelled step keeps the context and cost its agent reported (ADR 0013 §5)", async () => {
    const events: Array<RunEvent> = [];
    const usage = {
      context: { used: 15_305, size: 200_000 },
      cost: { amount: 0.039, currency: "USD" },
    };
    const workflow = defineWorkflow("cancel-usage", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        await ctx.agent("slow-step", "irrelevant");
        return {};
      },
    });
    const chunks = [
      { type: "CUSTOM", name: "acp.usage", value: usage },
      ...SLOW_CHUNKS,
      ...SLOW_CHUNKS,
      ...SLOW_CHUNKS,
    ];
    const handle = startRun(
      workflow,
      makeAgentRuntime(
        fakeAgents(
          createSlowFakeAdapter(chunks, 15, [
            { index: 0, signal: { _tag: "usage", value: usage } },
          ]),
        ),
      ),
      { runId: "run-cancel-usage", dir: "/tmp", input: {}, onEvent: (e) => events.push(e) },
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.cancel();
    expect((await handle.result).outcome).toBe("cancelled");

    const finished = events.find((e) => e.payload._tag === "AgentStepFinished");
    expect(finished?.payload).toMatchObject({
      outcome: "cancelled",
      context: { used: 15_305, size: 200_000 },
      cost: { amount: 0.039, currency: "USD" },
    });
  });

  test("a completed step records context and cost, and omits them when none came", async () => {
    const events: Array<RunEvent> = [];
    const usage = {
      context: { used: 1200, size: 200_000 },
      cost: { amount: 0.25, currency: "USD" },
    };
    const workflow = defineWorkflow("usage-fields", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        await ctx.agent("measured", "irrelevant");
        await ctx.agent("unmeasured", "irrelevant");
        return {};
      },
    });
    let call = 0;
    const adapter: AgentAdapter = {
      async prepareWorkspace() {},
      async *stream() {
        call += 1;
        if (call === 1) {
          yield {
            chunk: { type: "CUSTOM", name: "acp.usage", value: usage },
            signal: { _tag: "usage", value: usage },
          };
        }
        yield { chunk: { type: "RUN_FINISHED" } };
      },
    };
    const handle = startRun(workflow, makeAgentRuntime(fakeAgents(adapter)), {
      runId: "run-usage-fields",
      dir: "/tmp",
      input: {},
      onEvent: (e) => events.push(e),
    });
    expect((await handle.result).outcome).toBe("completed");

    const finished = events.flatMap((e) =>
      e.payload._tag === "AgentStepFinished" ? [e.payload] : [],
    );
    expect(finished[0]).toMatchObject({ context: usage.context, cost: usage.cost });
    expect("context" in finished[1]!).toBe(false);
    expect("cost" in finished[1]!).toBe(false);
  });

  test("an uninterrupted run completes normally through the same adapter", async () => {
    const workflow = defineWorkflow("no-cancel-test", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        const result = await ctx.agent("fast-step", "irrelevant, replay ignores it");
        return { finalText: result.finalText };
      },
    });

    const handle = startRun(
      workflow,
      makeAgentRuntime(fakeAgents(createSlowFakeAdapter(SLOW_CHUNKS, 1))),
      {
        runId: "run-no-cancel-test",
        dir: "/tmp",
        input: {},
        onEvent: () => {},
      },
    );

    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome === "completed") {
      expect(outcome.output).toEqual({ finalText: "hi there" });
    }
  });
});

describe("startRun workspace kind (issue #13)", () => {
  test("ctx.writeBack on a scratch workspace fails naming the kind, recorded like any other failure", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("scratch-wb", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        return await ctx.writeBack({
          branch: "scratch/nothing",
          commitMessage: "x",
          prTitle: "x",
          prBody: "x",
        });
      },
    });

    const handle = startRun(workflow, makeAgentRuntime(fakeAgents(createSlowFakeAdapter([]))), {
      runId: "run-scratch-wb",
      dir: "/tmp/nothing",
      input: {},
      workspaceKind: "scratch",
      repo: { slug: "owner/repo", baseBranch: "main" },
      onEvent: (event) => events.push(event),
    });

    const outcome = await handle.result;
    expect(outcome.outcome).toBe("failed");

    const finished = events.find((e) => e.payload._tag === "WriteBackFinished");
    expect(finished?.payload).toMatchObject({ outcome: "failed" });
    expect(
      finished?.payload._tag === "WriteBackFinished" && finished.payload.error?.includes("scratch"),
    ).toBe(true);
    // No git ran to reach the failure: no Exec events at all.
    expect(events.some((e) => e.payload._tag === "ExecStarted")).toBe(false);
  });

  test("ctx.writeBack still behaves as before on a clone workspace", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("clone-wb", {
      input: Schema.Struct({}),
      run: async (ctx) =>
        await ctx.writeBack({
          branch: "clone/nothing",
          commitMessage: "x",
          prTitle: "x",
          prBody: "x",
        }),
    });

    const handle = startRun(workflow, makeAgentRuntime(fakeAgents(createSlowFakeAdapter([]))), {
      runId: "run-clone-wb",
      dir: "/tmp/nothing",
      input: {},
      repo: { slug: "owner/repo", baseBranch: "main" },
      onEvent: (event) => events.push(event),
    });

    await handle.result;
    // Not the workspace-kind guard: write-back proceeds to git and fails there.
    expect(
      events.some(
        (e) =>
          e.payload._tag === "WriteBackFinished" && (e.payload.error ?? "").includes("scratch"),
      ),
    ).toBe(false);
  });

  test("RunStarted records the workspace kind, defaulting to clone", async () => {
    const workflow = defineWorkflow("kind-echo", {
      input: Schema.Struct({}),
      run: async () => ({}),
    });

    const scratchEvents: Array<RunEvent> = [];
    await startRun(workflow, makeAgentRuntime(fakeAgents(createSlowFakeAdapter([]))), {
      runId: "run-kind-scratch",
      dir: "/tmp/s",
      input: {},
      workspaceKind: "scratch",
      onEvent: (event) => scratchEvents.push(event),
    }).result;
    const cloneEvents: Array<RunEvent> = [];
    await startRun(workflow, makeAgentRuntime(fakeAgents(createSlowFakeAdapter([]))), {
      runId: "run-kind-clone",
      dir: "/tmp/c",
      input: {},
      onEvent: (event) => cloneEvents.push(event),
    }).result;

    expect(
      scratchEvents[0]?.payload._tag === "RunStarted" && scratchEvents[0].payload.workspaceKind,
    ).toBe("scratch");
    expect(
      cloneEvents[0]?.payload._tag === "RunStarted" && cloneEvents[0].payload.workspaceKind,
    ).toBe("clone");
  });
});

describe("startRun schedule trigger (issue #16)", () => {
  test("RunStarted records the starting schedule when started by one", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("scheduled-echo", {
      input: Schema.Struct({ issueNumber: Schema.Number }),
      run: async (ctx) => {
        const result = await ctx.agent("step", "irrelevant, replay ignores it");
        return { finalText: result.finalText };
      },
    });
    const handle = startRun(
      workflow,
      makeAgentRuntime(fakeAgents(createSlowFakeAdapter(SLOW_CHUNKS, 5))),
      {
        runId: "run-by-schedule",
        dir: "/tmp",
        input: { issueNumber: 7 },
        scheduleId: "nightly",
        onEvent: (event) => events.push(event),
      },
    );
    await handle.result;
    const started = events.find((e) => e.payload._tag === "RunStarted");
    expect(started?.payload).toMatchObject({ scheduleId: "nightly" });
  });

  test("a run started without a schedule records none", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("unscheduled-echo", {
      input: Schema.Struct({}),
      run: async () => ({}),
    });
    const handle = startRun(workflow, makeAgentRuntime(fakeAgents(createSlowFakeAdapter([]))), {
      runId: "run-manual",
      dir: "/tmp",
      input: {},
      onEvent: (event) => events.push(event),
    });
    await handle.result;
    const started = events.find((e) => e.payload._tag === "RunStarted");
    expect(started?.payload._tag === "RunStarted" && "scheduleId" in started.payload).toBe(false);
  });
});

describe("startRun model precedence (issue #16)", () => {
  test("an agent-level override from the schedule wins over the workflow default, and a per-call option over it", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("model-precedence", {
      input: Schema.Struct({}),
      agent: { model: "workflow-default" },
      run: async (ctx) => {
        await ctx.agent("scheduled-step", "irrelevant, replay ignores it");
        await ctx.agent("explicit-step", "irrelevant, replay ignores it", {
          model: "per-call-explicit",
        });
        return {};
      },
    });
    const handle = startRun(
      workflow,
      makeAgentRuntime(fakeAgents(createSlowFakeAdapter(SLOW_CHUNKS, 5))),
      {
        runId: "run-models",
        dir: "/tmp",
        input: {},
        agentOverrides: { model: "schedule-override" },
        onEvent: (event) => events.push(event),
      },
    );
    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");

    const models = events
      .filter((e) => e.payload._tag === "AgentStepStarted")
      .map((e) => (e.payload._tag === "AgentStepStarted" ? e.payload.model : undefined));
    // run request > schedule > workflow > config default
    expect(models).toEqual(["schedule-override", "per-call-explicit"]);
  });

  test("without a schedule override, the workflow default applies as before", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("model-precedence-fallback", {
      input: Schema.Struct({}),
      agent: { model: "workflow-default" },
      run: async (ctx) => {
        await ctx.agent("step", "irrelevant, replay ignores it");
        return {};
      },
    });
    const handle = startRun(
      workflow,
      makeAgentRuntime(fakeAgents(createSlowFakeAdapter(SLOW_CHUNKS, 5))),
      {
        runId: "run-models-fallback",
        dir: "/tmp",
        input: {},
        onEvent: (event) => events.push(event),
      },
    );
    const outcome = await handle.result;
    expect(outcome.outcome).toBe("completed");
    const started = events.find((e) => e.payload._tag === "AgentStepStarted");
    expect(started?.payload._tag === "AgentStepStarted" && started.payload.model).toBe(
      "workflow-default",
    );
  });
});

describe("startRun agent and model (ADR 0013 §2)", () => {
  function recordingAdapter(): AgentAdapter & {
    readonly calls: Array<Pick<AgentAdapterOptions, "agent" | "model">>;
  } {
    const calls: Array<Pick<AgentAdapterOptions, "agent" | "model">> = [];
    const inner = createSlowFakeAdapter(SLOW_CHUNKS, 1);
    return {
      calls,
      prepareWorkspace: inner.prepareWorkspace,
      stream: (options) => {
        calls.push({ agent: options.agent, model: options.model });
        return inner.stream(options);
      },
    };
  }

  const startedSteps = (events: ReadonlyArray<RunEvent>) =>
    events.flatMap((e) =>
      e.payload._tag === "AgentStepStarted"
        ? [{ agent: e.payload.agent, model: e.payload.model }]
        : [],
    );

  test("each level resolves, the adapter gets the agent and model, and AgentStepStarted records both", async () => {
    const events: Array<RunEvent> = [];
    const adapter = recordingAdapter();
    const workflow = defineWorkflow("agent-choice", {
      input: Schema.Struct({}),
      agent: { agent: "claude", model: "opus" },
      run: async (ctx) => {
        await ctx.agent("workflow-level", "p");
        await ctx.agent("model-only", "p", { model: "haiku" });
        await ctx.agent("agent-change", "p", { agent: "opencode" });
        await ctx.agent("both", "p", { agent: "opencode", model: "opencode/other" });
        return {};
      },
    });
    const handle = startRun(
      workflow,
      makeAgentRuntime({
        adapter,
        default: "opencode",
        models: { claude: "sonnet", opencode: "opencode/big-pickle" },
      }),
      { runId: "run-agent-choice", dir: "/tmp", input: {}, onEvent: (e) => events.push(e) },
    );
    expect((await handle.result).outcome).toBe("completed");

    const expected: Array<Pick<AgentAdapterOptions, "agent" | "model">> = [
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "haiku" },
      // The workflow's `opus` belongs to claude: it does not carry across.
      { agent: "opencode", model: "opencode/big-pickle" },
      { agent: "opencode", model: "opencode/other" },
    ];
    expect(startedSteps(events)).toEqual(expected);
    expect(adapter.calls).toEqual(expected);
  });

  test("the run level (request or schedule) sits between the call and the workflow", async () => {
    const events: Array<RunEvent> = [];
    const workflow = defineWorkflow("agent-choice-run-level", {
      input: Schema.Struct({}),
      agent: { model: "workflow-model" },
      run: async (ctx) => {
        await ctx.agent("step", "p");
        return {};
      },
    });
    const handle = startRun(
      workflow,
      makeAgentRuntime({ adapter: recordingAdapter(), models: { claude: "sonnet" } }),
      {
        runId: "run-agent-choice-run-level",
        dir: "/tmp",
        input: {},
        agentOverrides: { agent: "claude" },
        onEvent: (e) => events.push(e),
      },
    );
    expect((await handle.result).outcome).toBe("completed");
    expect(startedSteps(events)).toEqual([{ agent: "claude", model: "sonnet" }]);
  });

  test("an unresolvable model fails the run before the step starts, naming the fix", async () => {
    const events: Array<RunEvent> = [];
    const adapter = recordingAdapter();
    const workflow = defineWorkflow("agent-choice-unresolvable", {
      input: Schema.Struct({}),
      run: async (ctx) => {
        await ctx.agent("implement", "p", { agent: "claude" });
        return {};
      },
    });
    const handle = startRun(
      workflow,
      makeAgentRuntime({ adapter, models: { opencode: "opencode/big-pickle" } }),
      { runId: "run-agent-choice-none", dir: "/tmp", input: {}, onEvent: (e) => events.push(e) },
    );
    const outcome = await handle.result;
    expect(outcome.outcome).toBe("failed");
    expect(outcome.outcome === "failed" && outcome.error).toBe(
      'agent step "implement": no model for agent "claude": name one with `model` on the ctx.agent call, ' +
        "the run, the schedule or the workflow, or set `agent.models.claude` in factory.config.ts",
    );
    expect(startedSteps(events)).toEqual([]);
    expect(adapter.calls).toEqual([]);
  });
});

describe("startRun prepareWorkspace (ADR 0012 §3, #37)", () => {
  function trackingAdapter(): AgentAdapter & { readonly prepared: Array<string> } {
    const prepared: Array<string> = [];
    const inner = createSlowFakeAdapter([]);
    return {
      prepared,
      async prepareWorkspace(dir: string): Promise<void> {
        prepared.push(dir);
      },
      stream: inner.stream.bind(inner),
    };
  }

  test("calls adapter.prepareWorkspace when prepareWorkspace is true", async () => {
    const events: Array<RunEvent> = [];
    const adapter = trackingAdapter();
    const workflow = defineWorkflow("prep-clone", {
      input: Schema.Struct({}),
      run: async () => ({}),
    });

    await startRun(workflow, makeAgentRuntime(fakeAgents(adapter)), {
      runId: "run-prep-clone",
      dir: "/tmp/clone-dir",
      input: {},
      prepareWorkspace: true,
      onEvent: (event) => events.push(event),
    }).result;

    expect(adapter.prepared).toEqual(["/tmp/clone-dir"]);
  });

  test("does not call adapter.prepareWorkspace when prepareWorkspace is absent", async () => {
    const adapter = trackingAdapter();
    const workflow = defineWorkflow("prep-scratch", {
      input: Schema.Struct({}),
      run: async () => ({}),
    });

    await startRun(workflow, makeAgentRuntime(fakeAgents(adapter)), {
      runId: "run-prep-scratch",
      dir: "/tmp/scratch-dir",
      input: {},
      onEvent: () => {},
    }).result;

    expect(adapter.prepared).toEqual([]);
  });
});
