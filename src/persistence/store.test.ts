import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../events";
import { appendEvent, getRunEvents, listRuns, openStore } from "./store";

function event(runId: string, seq: number, payload: RunEvent["payload"]): RunEvent {
  return { runId, seq, ts: 1_000 + seq, payload };
}

describe("persistence/store", () => {
  test("round-trips events through sqlite in seq order", () => {
    const db = openStore(":memory:");
    const events: ReadonlyArray<RunEvent> = [
      event("run-a", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp/a", input: {} }),
      event("run-a", 1, {
        _tag: "AgentStepStarted",
        stepId: "step-0",
        name: "implement",
        model: "m",
        prompt: "p",
        structured: false,
      }),
      event("run-a", 2, { _tag: "RunFinished", durationMs: 10 }),
    ];
    for (const e of events) appendEvent(db, e);

    expect(getRunEvents(db, "run-a")).toEqual(events);
  });

  test("a run with no terminal event is reported interrupted", () => {
    const db = openStore(":memory:");
    appendEvent(db, event("run-crashed", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp/b", input: {} }));
    appendEvent(db, event("run-crashed", 1, { _tag: "ExecStarted", execId: "exec-0", command: ["bun", "test"], cwd: "/tmp/b" }));
    // process died here — no RunFinished/RunFailed/RunCancelled ever written

    const [summary] = listRuns(db);
    expect(summary?.status).toBe("interrupted");
    expect(summary?.eventCount).toBe(2);
    expect(summary?.finishedAt).toBeUndefined();
  });

  test("a completed run is reported with its terminal status", () => {
    const db = openStore(":memory:");
    appendEvent(db, event("run-ok", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp/c", input: {} }));
    appendEvent(db, event("run-ok", 1, { _tag: "RunFinished", durationMs: 5 }));

    const [summary] = listRuns(db);
    expect(summary?.status).toBe("RunFinished");
    expect(summary?.finishedAt).toBe(1001);
  });

  test("listRuns reports every distinct run", () => {
    const db = openStore(":memory:");
    appendEvent(db, event("run-1", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp", input: {} }));
    appendEvent(db, event("run-2", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp", input: {} }));

    expect(listRuns(db).map((r) => r.runId)).toEqual(["run-1", "run-2"]);
  });
});
