import { describe, expect, test } from "bun:test";
import { isTerminal, type RunEvent } from "../events";
import {
  appendEvent,
  getRunEvents,
  listRuns,
  openStore,
  type RunStatus,
  type RunSummary,
} from "./store";

function event(runId: string, seq: number, payload: RunEvent["payload"]): RunEvent {
  return { runId, seq, ts: 1_000 + seq, payload };
}

function eventAt(runId: string, seq: number, ts: number, payload: RunEvent["payload"]): RunEvent {
  return { runId, seq, ts, payload };
}

/**
 * The pre-refactor definition of a summary, kept here as an oracle: `listRuns`
 * must produce exactly these fields after G2's cheap-summary rewrite. Reads
 * every event on purpose — correct but expensive is the reference.
 */
function referenceSummary(runId: string, events: ReadonlyArray<RunEvent>): RunSummary {
  const started = events.find((e) => e.payload._tag === "RunStarted");
  const terminal = events.find((e) => isTerminal(e.payload));
  return {
    runId,
    workflowId: started?.payload._tag === "RunStarted" ? started.payload.workflowId : undefined,
    dir: started?.payload._tag === "RunStarted" ? started.payload.dir : undefined,
    workspaceKind:
      started?.payload._tag === "RunStarted" ? (started.payload.workspaceKind ?? "clone") : "clone",
    startedAt: events[0]?.ts ?? 0,
    finishedAt: terminal?.ts,
    status: terminal !== undefined ? (terminal.payload._tag as RunStatus) : "interrupted",
    eventCount: events.length,
    input: started?.payload._tag === "RunStarted" ? started.payload.input : undefined,
    output: terminal?.payload._tag === "RunFinished" ? terminal.payload.output : undefined,
  };
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
    appendEvent(
      db,
      event("run-crashed", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp/b", input: {} }),
    );
    appendEvent(
      db,
      event("run-crashed", 1, {
        _tag: "ExecStarted",
        execId: "exec-0",
        command: ["bun", "test"],
        cwd: "/tmp/b",
      }),
    );
    // process died here — no RunFinished/RunFailed/RunCancelled ever written

    const [summary] = listRuns(db);
    expect(summary?.status).toBe("interrupted");
    expect(summary?.eventCount).toBe(2);
    expect(summary?.finishedAt).toBeUndefined();
  });

  test("a completed run is reported with its terminal status", () => {
    const db = openStore(":memory:");
    appendEvent(
      db,
      event("run-ok", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp/c", input: {} }),
    );
    appendEvent(db, event("run-ok", 1, { _tag: "RunFinished", durationMs: 5 }));

    const [summary] = listRuns(db);
    expect(summary?.status).toBe("RunFinished");
    expect(summary?.finishedAt).toBe(1001);
  });

  test("listRuns surfaces RunStarted.input and RunFinished.output (the runs-table PR link)", () => {
    const db = openStore(":memory:");
    appendEvent(
      db,
      event("run-pr", 0, {
        _tag: "RunStarted",
        workflowId: "implement-issue",
        dir: "/tmp/pr",
        input: { issueNumber: 5 },
      }),
    );
    appendEvent(
      db,
      event("run-pr", 1, {
        _tag: "RunFinished",
        durationMs: 5,
        output: { prUrl: "https://github.com/example/repo/pull/5" },
      }),
    );

    const [summary] = listRuns(db);
    expect(summary?.input).toEqual({ issueNumber: 5 });
    expect(summary?.output).toEqual({ prUrl: "https://github.com/example/repo/pull/5" });
  });

  test("listRuns reports every distinct run", () => {
    const db = openStore(":memory:");
    appendEvent(
      db,
      event("run-1", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp", input: {} }),
    );
    appendEvent(
      db,
      event("run-2", 0, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp", input: {} }),
    );

    expect(listRuns(db).map((r) => r.runId)).toEqual(["run-1", "run-2"]);
  });

  test("listRuns orders by start time, newest first — not by runId", () => {
    const db = openStore(":memory:");
    const start = (runId: string, ts: number): RunEvent =>
      eventAt(runId, 0, ts, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp", input: {} });

    // Insertion order, runId order and start order all disagree, so only a
    // start-time sort yields the expected sequence. `run-zzz`'s second event is
    // back-dated (as `sandbox.file` chunks are) to pin that the start time is
    // the *first* event's ts, not the run's minimum ts.
    appendEvent(db, start("run-mmm", 2_000));
    appendEvent(db, start("run-zzz", 3_000));
    appendEvent(db, start("run-aaa", 1_000));
    appendEvent(
      db,
      eventAt("run-zzz", 1, 10, { _tag: "LogRecorded", name: "back-dated", data: {} }),
    );

    expect(listRuns(db).map((r) => r.runId)).toEqual(["run-zzz", "run-mmm", "run-aaa"]);
  });

  test("listRuns breaks start-time ties deterministically by runId", () => {
    const db = openStore(":memory:");
    const start = (runId: string): RunEvent =>
      eventAt(runId, 0, 5_000, { _tag: "RunStarted", workflowId: "wf", dir: "/tmp", input: {} });

    appendEvent(db, start("run-b"));
    appendEvent(db, start("run-a"));

    expect(listRuns(db).map((r) => r.runId)).toEqual(["run-a", "run-b"]);
  });

  test("listRuns summaries are field-equivalent to reading every event (G2)", () => {
    const db = openStore(":memory:");
    const started = (runId: string, ts: number, dir: string): RunEvent =>
      eventAt(runId, 0, ts, { _tag: "RunStarted", workflowId: `wf-${runId}`, dir, input: {} });

    // A completed, a failed, a cancelled and an interrupted run, with events
    // interleaved across runs so no per-run read order is assumed.
    appendEvent(db, started("run-ok", 100, "/ok"));
    appendEvent(db, started("run-bad", 300, "/bad"));
    appendEvent(db, started("run-cancelled", 400, "/cancelled"));
    appendEvent(db, started("run-dead", 500, "/dead"));
    appendEvent(
      db,
      eventAt("run-ok", 1, 110, {
        _tag: "AgentStepStarted",
        stepId: "step-0",
        name: "implement",
        model: "m",
        prompt: "p",
        structured: false,
      }),
    );
    appendEvent(
      db,
      eventAt("run-bad", 1, 310, { _tag: "RunFailed", message: "boom", durationMs: 10 }),
    );
    appendEvent(db, eventAt("run-ok", 2, 120, { _tag: "RunFinished", durationMs: 20 }));
    appendEvent(db, eventAt("run-cancelled", 1, 410, { _tag: "RunCancelled", durationMs: 5 }));
    // run-dead gets no terminal event — it is the interrupted case.

    const actual = new Map(listRuns(db).map((summary) => [summary.runId, summary]));
    for (const runId of ["run-ok", "run-bad", "run-cancelled", "run-dead"]) {
      expect(actual.get(runId)).toEqual(referenceSummary(runId, getRunEvents(db, runId)));
    }
  });
});

describe("RunSummary.workspaceKind (issue #13)", () => {
  test("derived from RunStarted when present; defaults to clone when absent", () => {
    const db = openStore(":memory:");
    appendEvent(
      db,
      event("run-scratch", 0, {
        _tag: "RunStarted",
        workflowId: "check-on-cron",
        dir: "/tmp/s",
        input: {},
        workspaceKind: "scratch",
      }),
    );
    appendEvent(db, event("run-scratch", 1, { _tag: "RunFinished", durationMs: 5 }));
    appendEvent(
      db,
      event("run-old", 0, {
        _tag: "RunStarted",
        workflowId: "wf",
        dir: "/tmp/c",
        input: {},
      }),
    );

    const byRunId = new Map(listRuns(db).map((run) => [run.runId, run]));
    expect(byRunId.get("run-scratch")?.workspaceKind).toBe("scratch");
    expect(byRunId.get("run-old")?.workspaceKind).toBe("clone");
  });
});
