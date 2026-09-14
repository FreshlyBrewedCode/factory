import { describe, expect, test } from "bun:test";
import type { RunEvent, RunEventPayload } from "../../events";
import { deriveRunMeta, deriveSteps, summarizeEvent } from "./run-events";

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
