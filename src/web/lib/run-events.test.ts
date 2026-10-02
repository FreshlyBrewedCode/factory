import { describe, expect, test } from "bun:test";
import { agentStepContextTokens, type RunEvent, type RunEventPayload } from "../../events";
import { ACP_CHUNK } from "../../runtime/acp-adapter";
import {
  ACP_USAGE_CHUNK,
  deriveRunMeta,
  deriveSteps,
  runCost,
  summarizeEvent,
  type AgentStepView,
} from "./run-events";

function event(seq: number, payload: RunEventPayload): RunEvent {
  return { runId: "run-test", seq, ts: 1_000 + seq, payload };
}

const STARTED: RunEvent = event(0, {
  _tag: "RunStarted",
  workflowId: "wf",
  dir: "/tmp/wf",
  input: { issueNumber: 7 },
});

describe("deriveSteps", () => {
  test("an agent step appears on AgentStepStarted and gains its outcome on AgentStepFinished", () => {
    const events: ReadonlyArray<RunEvent> = [
      STARTED,
      event(1, {
        _tag: "AgentStepStarted",
        stepId: "step-0",
        name: "implement",
        model: "m",
        prompt: "do it",
        structured: false,
      }),
      event(2, {
        _tag: "AgentChunk",
        stepId: "step-0",
        chunkType: "TEXT_MESSAGE_START",
        chunk: {},
      }),
      event(3, {
        _tag: "AgentStepFinished",
        stepId: "step-0",
        name: "implement",
        outcome: "completed",
        chunkCount: 1,
        durationMs: 42,
        finalText: "done",
        sessionId: "ses-1",
      }),
    ];

    const steps = deriveSteps(events);
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.kind).toBe("agent");
    expect(step.status).toBe("completed");
    expect(step.name).toBe("implement");
    expect(step.startedTs).toBe(1_001);
    if (step.kind !== "agent") throw new Error("unreachable");
    expect(step.durationMs).toBe(42);
    expect(step.sessionId).toBe("ses-1");
  });

  test("an agent step carries its agent beside the model, and an old log has none (ADR 0013 §2)", () => {
    const started = (stepId: string, agent: string | undefined): RunEvent =>
      event(stepId === "step-0" ? 1 : 2, {
        _tag: "AgentStepStarted",
        stepId,
        name: stepId,
        ...(agent !== undefined ? { agent } : {}),
        model: "sonnet",
        prompt: "p",
        structured: false,
      });
    const finished = event(3, {
      _tag: "AgentStepFinished",
      stepId: "step-0",
      name: "step-0",
      outcome: "completed",
      chunkCount: 0,
      durationMs: 1,
      finalText: "",
    });
    const steps = deriveSteps([
      STARTED,
      started("step-0", "claude"),
      started("step-1", undefined),
      finished,
    ]);
    const agents = steps.map((step) => (step.kind === "agent" ? [step.agent, step.model] : []));
    // The finished step keeps the agent it started with.
    expect(agents).toEqual([
      ["claude", "sonnet"],
      [undefined, "sonnet"],
    ]);
    expect(summarizeEvent(started("step-0", "claude"))).toBe("step-0 · claude · sonnet");
    expect(summarizeEvent(started("step-1", undefined))).toBe("step-1 · sonnet");
  });

  test("an agent step takes usage from AgentStepFinished, not from the raw chunk", () => {
    // The numbers are step-0 of run-69780571 verbatim. The RUN_FINISHED chunk
    // is present and carries the adapter's under-reported `totalTokens: 3648`;
    // the projection must ignore it and read the typed payload, whose context
    // total is 36,288 — what opencode itself reports for the session.
    const events: ReadonlyArray<RunEvent> = [
      STARTED,
      event(1, {
        _tag: "AgentStepStarted",
        stepId: "step-0",
        name: "find-next-issue",
        model: "m",
        prompt: "do it",
        structured: false,
      }),
      event(2, {
        _tag: "AgentChunk",
        stepId: "step-0",
        chunkType: "RUN_FINISHED",
        chunk: {
          usage: {
            promptTokens: 2037,
            completionTokens: 1611,
            totalTokens: 3648,
            promptTokensDetails: { cachedTokens: 32640 },
          },
        },
      }),
      event(3, {
        _tag: "AgentStepFinished",
        stepId: "step-0",
        name: "find-next-issue",
        outcome: "completed",
        chunkCount: 1,
        durationMs: 42,
        finalText: "done",
        sessionId: "ses-1",
        usage: {
          inputTokens: 2037,
          outputTokens: 1611,
          cachedInputTokens: 32640,
          reasoningTokens: 0,
        },
      }),
    ];

    const steps = deriveSteps(events);
    const step = steps[0]!;
    if (step.kind !== "agent") throw new Error("unreachable");
    expect(step.usage).toEqual({
      inputTokens: 2037,
      outputTokens: 1611,
      cachedInputTokens: 32640,
      reasoningTokens: 0,
    });
    expect(agentStepContextTokens(step.usage!)).toBe(36_288);
  });

  test("an agent step with no usage on its finished event reports none", () => {
    const steps = deriveSteps([
      STARTED,
      event(1, {
        _tag: "AgentStepStarted",
        stepId: "step-0",
        name: "implement",
        model: "m",
        prompt: "do it",
        structured: false,
      }),
      event(2, {
        _tag: "AgentStepFinished",
        stepId: "step-0",
        name: "implement",
        outcome: "cancelled",
        chunkCount: 1,
        durationMs: 42,
        finalText: "",
      }),
    ]);
    const step = steps[0]!;
    if (step.kind !== "agent") throw new Error("unreachable");
    expect(step.usage).toBeUndefined();
  });

  test("an agent step is running until its finished event arrives", () => {
    const startedOnly = deriveSteps([
      STARTED,
      event(1, {
        _tag: "AgentStepStarted",
        stepId: "step-0",
        name: "fix",
        model: "m",
        prompt: "p",
        structured: false,
      }),
    ]);
    expect(startedOnly[0]?.status).toBe("running");
  });

  test("exec steps correlate by execId and carry the command as their name", () => {
    const steps = deriveSteps([
      STARTED,
      event(1, { _tag: "ExecStarted", execId: "exec-0", command: ["bun", "test"], cwd: "/tmp/wf" }),
      event(2, {
        _tag: "ExecFinished",
        execId: "exec-0",
        command: ["bun", "test"],
        exitCode: 1,
        stdout: "boom",
        stderr: "",
        durationMs: 9,
      }),
    ]);
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.kind).toBe("exec");
    expect(step.status).toBe("failed");
    if (step.kind !== "exec") throw new Error("unreachable");
    expect(step.command).toEqual(["bun", "test"]);
    expect(step.exitCode).toBe(1);
  });

  test("an exec with no finished event reads as interrupted once the run is no longer live", () => {
    const steps = deriveSteps(
      [
        STARTED,
        event(1, {
          _tag: "ExecStarted",
          execId: "exec-0",
          command: ["sleep", "30"],
          cwd: "/tmp/wf",
        }),
      ],
      { active: false },
    );
    expect(steps[0]?.status).toBe("interrupted");
  });

  test("an exec with no finished event reads as running while the run is live", () => {
    const steps = deriveSteps([
      STARTED,
      event(1, { _tag: "ExecStarted", execId: "exec-0", command: ["sleep", "30"], cwd: "/tmp/wf" }),
    ]);
    expect(steps[0]?.status).toBe("running");
  });

  test("assertions are their own step with pass/fail status", () => {
    const steps = deriveSteps([
      STARTED,
      event(1, { _tag: "AssertionRecorded", name: "check", pass: false, details: { why: "no" } }),
    ]);
    expect(steps[0]?.kind).toBe("assert");
    expect(steps[0]?.status).toBe("fail");
  });

  test("write-back correlates Started and Finished by branch", () => {
    const steps = deriveSteps([
      STARTED,
      event(1, { _tag: "WriteBackStarted", branch: "factory/x" }),
      event(2, {
        _tag: "WriteBackFinished",
        branch: "factory/x",
        outcome: "completed",
        cleanedArtifacts: [],
        stagedPaths: ["a.ts"],
        prUrl: "https://example.test/pr/1",
      }),
    ]);
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.kind).toBe("writeback");
    expect(step.status).toBe("completed");
    if (step.kind !== "writeback") throw new Error("unreachable");
    expect(step.prUrl).toBe("https://example.test/pr/1");
    expect(step.stagedPaths).toEqual(["a.ts"]);
  });

  test("write-back that collided reports the branch actually used", () => {
    const steps = deriveSteps([
      STARTED,
      event(1, { _tag: "WriteBackStarted", branch: "factory/x" }),
      event(2, {
        _tag: "WriteBackFinished",
        branch: "factory/x",
        usedBranch: "factory/x-c1a2b3c4",
        outcome: "completed",
        cleanedArtifacts: [],
        stagedPaths: ["a.ts"],
        prUrl: "https://example.test/pr/1",
      }),
    ]);
    expect(steps).toHaveLength(1);
    if (steps[0]?.kind !== "writeback") throw new Error("unreachable");
    expect(steps[0].branch).toBe("factory/x-c1a2b3c4");
  });

  test("logs are kept in seq order but the terminal run event is not a step", () => {
    const steps = deriveSteps([
      STARTED,
      event(1, { _tag: "LogRecorded", name: "started", data: { n: 1 } }),
      event(2, { _tag: "RunFinished", durationMs: 100 }),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(["log"]);
  });
});

describe("deriveRunMeta", () => {
  test("reads input from RunStarted and output from RunFinished", () => {
    const meta = deriveRunMeta([
      STARTED,
      event(1, { _tag: "RunFinished", durationMs: 100, output: { prUrl: "u" } }),
    ]);
    expect(meta.input).toEqual({ issueNumber: 7 });
    expect(meta.output).toEqual({ prUrl: "u" });
    expect(meta.error).toBeUndefined();
  });

  test("reads the failure message from RunFailed and the cancellation from RunCancelled", () => {
    expect(
      deriveRunMeta([STARTED, event(1, { _tag: "RunFailed", message: "boom", durationMs: 5 })])
        .error,
    ).toBe("boom");
    expect(
      deriveRunMeta([STARTED, event(1, { _tag: "RunCancelled", durationMs: 3 })]).cancelled,
    ).toBe(true);
  });
});

describe("summarizeEvent", () => {
  test("names the subject of each factory event", () => {
    expect(
      summarizeEvent(
        event(1, {
          _tag: "AgentStepStarted",
          stepId: "s",
          name: "implement",
          model: "m",
          prompt: "p",
          structured: false,
        }),
      ),
    ).toContain("implement");
    expect(
      summarizeEvent(
        event(2, { _tag: "ExecStarted", execId: "e", command: ["bun", "test"], cwd: "/" }),
      ),
    ).toContain("bun test");
    expect(summarizeEvent(event(3, { _tag: "WriteBackStarted", branch: "b" }))).toContain("b");
  });
});

describe("deriveRunMeta.workspaceKind (issue #13)", () => {
  test("surfaces the RunStarted kind, defaulting to clone when absent", () => {
    const scratch = deriveRunMeta([
      event(0, {
        _tag: "RunStarted",
        workflowId: "wf",
        dir: "/tmp/wf",
        input: {},
        workspaceKind: "scratch",
      }),
    ]);
    const legacy = deriveRunMeta([STARTED]);

    expect(scratch.workspaceKind).toBe("scratch");
    expect(legacy.workspaceKind).toBe("clone");
  });
});

describe("parent/child navigation (issue #14)", () => {
  test("deriveRunMeta reads the child's parentId", () => {
    const child = deriveRunMeta([
      event(0, {
        _tag: "RunStarted",
        workflowId: "wf",
        dir: "/tmp/wf",
        input: {},
        parentId: "run-parent",
      }),
    ]);
    const topLevel = deriveRunMeta([STARTED]);

    expect(child.parentId).toBe("run-parent");
    expect(topLevel.parentId).toBeUndefined();
  });

  test("deriveRunMeta collects the parent's dispatched children", () => {
    const meta = deriveRunMeta([
      STARTED,
      event(1, { _tag: "RunDispatched", childRunId: "run-a", childWorkflowId: "wf", input: {} }),
      event(2, { _tag: "RunDispatched", childRunId: "run-b", childWorkflowId: "wf", input: {} }),
    ]);

    expect(meta.dispatched).toEqual([
      { childRunId: "run-a", childWorkflowId: "wf" },
      { childRunId: "run-b", childWorkflowId: "wf" },
    ]);
    expect(deriveRunMeta([STARTED]).dispatched).toEqual([]);
  });

  test("summarizeEvent names the dispatched child", () => {
    expect(
      summarizeEvent(
        event(1, {
          _tag: "RunDispatched",
          childRunId: "run-a",
          childWorkflowId: "wf",
          input: {},
        }),
      ),
    ).toContain("wf");
  });
});

describe("dedupe keys (issue #15)", () => {
  test("deriveRunMeta reads the run's dedupe key, absent without one", () => {
    const keyed = deriveRunMeta([
      event(0, {
        _tag: "RunStarted",
        workflowId: "wf",
        dir: "/tmp/wf",
        input: {},
        dedupeKey: "issue:41",
      }),
    ]);
    const unkeyed = deriveRunMeta([STARTED]);
    expect(keyed.dedupeKey).toBe("issue:41");
    expect(unkeyed.dedupeKey).toBeUndefined();
  });

  test("deriveRunMeta collects dispatch collisions, holding run reachable from them", () => {
    const meta = deriveRunMeta([
      STARTED,
      event(1, {
        _tag: "DispatchCollision",
        key: "issue:41",
        holderRunId: "run-holder",
        childWorkflowId: "wf",
      }),
    ]);
    expect(meta.collisions).toEqual([
      { key: "issue:41", holderRunId: "run-holder", childWorkflowId: "wf" },
    ]);
    expect(deriveRunMeta([STARTED]).collisions).toEqual([]);
  });

  test("a keyed RunDispatched still yields the same dispatched list", () => {
    const meta = deriveRunMeta([
      STARTED,
      event(1, {
        _tag: "RunDispatched",
        childRunId: "run-a",
        childWorkflowId: "wf",
        input: {},
        dedupeKey: "issue:41",
      }),
    ]);
    expect(meta.dispatched).toEqual([{ childRunId: "run-a", childWorkflowId: "wf" }]);
  });

  test("summarizeEvent names the key and the holder on a collision; key on a dispatch", () => {
    expect(
      summarizeEvent(
        event(1, {
          _tag: "DispatchCollision",
          key: "issue:41",
          holderRunId: "run-holder",
          childWorkflowId: "wf",
        }),
      ),
    ).toContain("run-holder");
    expect(
      summarizeEvent(
        event(2, {
          _tag: "RunDispatched",
          childRunId: "run-a",
          childWorkflowId: "wf",
          input: {},
          dedupeKey: "issue:41",
        }),
      ),
    ).toContain("issue:41");
  });
});

describe("context and cost per agent step (ADR 0013 §5)", () => {
  const started = (seq: number, stepId: string): RunEvent =>
    event(seq, {
      _tag: "AgentStepStarted",
      stepId,
      name: stepId,
      agent: "claude",
      model: "sonnet",
      prompt: "p",
      structured: false,
    });
  const usage = (
    seq: number,
    stepId: string,
    used: number,
    size: number,
    cost?: { amount: number; currency: string },
  ): RunEvent =>
    event(seq, {
      _tag: "AgentChunk",
      stepId,
      chunkType: "CUSTOM",
      chunk: {
        type: "CUSTOM",
        name: "acp.usage",
        value: { context: { used, size }, ...(cost !== undefined && { cost }) },
      },
    });
  const finished = (seq: number, stepId: string, extra: Record<string, unknown> = {}): RunEvent =>
    event(seq, {
      _tag: "AgentStepFinished",
      stepId,
      name: stepId,
      outcome: "completed",
      chunkCount: 3,
      durationMs: 10,
      finalText: "",
      ...extra,
    } as RunEventPayload);
  const agent = (steps: ReturnType<typeof deriveSteps>, i = 0) => steps[i] as AgentStepView;

  test("the chunk name is the one the adapter emits", () => {
    expect(ACP_USAGE_CHUNK).toBe(ACP_CHUNK.usage);
  });

  test("a running step's context follows its latest acp.usage chunk", () => {
    const first = [STARTED, started(1, "s"), usage(2, "s", 14_874, 200_000)];
    expect(agent(deriveSteps(first)).context).toEqual({
      used: 14_874,
      size: 200_000,
      source: "reported",
    });
    const later = [...first, usage(3, "s", 15_305, 200_000)];
    const step = agent(deriveSteps(later));
    expect(step.status).toBe("running");
    expect(step.context?.used).toBe(15_305);
    expect(step.cost).toBeUndefined();
    expect(step.chunkCount).toBe(2);
  });

  test("a usage chunk without cost keeps the cost an earlier one reported", () => {
    const steps = deriveSteps([
      STARTED,
      started(1, "s"),
      usage(2, "s", 100, 1000, { amount: 0.02, currency: "USD" }),
      usage(3, "s", 200, 1000),
    ]);
    expect(agent(steps).cost).toEqual({ amount: 0.02, currency: "USD" });
  });

  test("the recorded fields win once the step finishes", () => {
    const steps = deriveSteps([
      STARTED,
      started(1, "s"),
      usage(2, "s", 100, 1000),
      finished(3, "s", {
        context: { used: 15_305, size: 200_000 },
        cost: { amount: 0.0391796, currency: "USD" },
        usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 36_386, reasoningTokens: 0 },
      }),
    ]);
    expect(agent(steps).context).toEqual({ used: 15_305, size: 200_000, source: "reported" });
    expect(agent(steps).cost).toEqual({ amount: 0.0391796, currency: "USD" });
  });

  test("a step finished without the fields keeps what its chunks reported", () => {
    // A log written by the ACP adapter before AgentStepFinished had the fields.
    const steps = deriveSteps([
      STARTED,
      started(1, "s"),
      usage(2, "s", 15_270, 1_000_000, { amount: 0.0275702, currency: "USD" }),
      finished(3, "s", {
        usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 36_386, reasoningTokens: 0 },
      }),
    ]);
    expect(agent(steps).context).toEqual({ used: 15_270, size: 1_000_000, source: "reported" });
    expect(agent(steps).cost).toEqual({ amount: 0.0275702, currency: "USD" });
  });

  test("an old log falls back to agentStepContextTokens, with no window and no cost", () => {
    const usageFields = {
      inputTokens: 260,
      outputTokens: 288,
      cachedInputTokens: 14_208,
      reasoningTokens: 927,
    };
    const steps = deriveSteps([STARTED, started(1, "s"), finished(2, "s", { usage: usageFields })]);
    expect(agent(steps).context).toEqual({
      used: agentStepContextTokens(usageFields),
      size: undefined,
      source: "derived",
    });
    expect(agent(steps).cost).toBeUndefined();
  });

  test("a cancelled step keeps its context and cost", () => {
    const steps = deriveSteps([
      STARTED,
      started(1, "s"),
      finished(2, "s", {
        outcome: "cancelled",
        context: { used: 9000, size: 200_000 },
        cost: { amount: 0.01, currency: "USD" },
      }),
    ]);
    expect(agent(steps).status).toBe("cancelled");
    expect(agent(steps).context?.used).toBe(9000);
    expect(agent(steps).cost?.amount).toBe(0.01);
  });

  test("usage chunks for one step never touch another", () => {
    const steps = deriveSteps([
      STARTED,
      started(1, "a"),
      started(2, "b"),
      usage(3, "b", 500, 1000),
    ]);
    expect(agent(steps, 0).context).toBeUndefined();
    expect(agent(steps, 1).context?.used).toBe(500);
  });

  test("runCost sums step costs per currency, running steps included", () => {
    const steps = deriveSteps([
      STARTED,
      started(1, "a"),
      finished(2, "a", { cost: { amount: 0.039, currency: "USD" } }),
      started(3, "b"),
      finished(4, "b", { cost: { amount: 0, currency: "USD" } }),
      started(5, "c"),
      usage(6, "c", 10, 100, { amount: 0.028, currency: "USD" }),
      started(7, "d"),
      finished(8, "d"),
    ]);
    const [total, ...rest] = runCost(steps);
    expect(rest).toEqual([]);
    expect(total?.currency).toBe("USD");
    expect(total?.amount).toBeCloseTo(0.067, 10);
  });

  test("runCost is empty when no step reported a cost, and keeps currencies apart", () => {
    expect(runCost(deriveSteps([STARTED, started(1, "a"), finished(2, "a")]))).toEqual([]);
    const mixed = deriveSteps([
      STARTED,
      started(1, "a"),
      finished(2, "a", { cost: { amount: 1, currency: "USD" } }),
      started(3, "b"),
      finished(4, "b", { cost: { amount: 2, currency: "EUR" } }),
    ]);
    expect(runCost(mixed)).toEqual([
      { amount: 1, currency: "USD" },
      { amount: 2, currency: "EUR" },
    ]);
  });
});
