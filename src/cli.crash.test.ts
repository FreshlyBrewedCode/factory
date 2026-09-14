import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { getRunEvents, listRuns, openStore } from "./persistence/store";

const SLOW_WORKFLOW = `${import.meta.dir}/../test/fixtures/slow-workflow.ts`;
const CLI = `${import.meta.dir}/cli.ts`;

describe("phase 2 exit criterion: interrupted runs stay queryable", () => {
  test("SIGKILL mid-run leaves a partial, interrupted history in sqlite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-crash-test-"));
    const dbPath = join(dir, "factory.db");

    const proc = Bun.spawn(
      ["bun", CLI, "run", SLOW_WORKFLOW, "--input", "{}", "--dir", dir, "--db", dbPath],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let seenExecStarted = false;
    while (!seenExecStarted) {
      const { value, done } = await reader.read();
      if (done) throw new Error("CLI exited before emitting ExecStarted");
      if (decoder.decode(value).includes("ExecStarted")) seenExecStarted = true;
    }
    reader.releaseLock();
    await Bun.sleep(200);

    proc.kill("SIGKILL");
    await proc.exited;

    const db = openStore(dbPath);
    const runs = listRuns(db);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("interrupted");
    expect(run.finishedAt).toBeUndefined();

    const events = getRunEvents(db, run.runId);
    const tags = events.map((e) => e.payload._tag);
    expect(tags).toContain("RunStarted");
    expect(tags).toContain("ExecStarted");
    expect(tags).not.toContain("RunFinished");
    expect(tags).not.toContain("RunFailed");
    expect(tags).not.toContain("RunCancelled");
    db.close();

    const restarted = openStore(dbPath);
    const runsAfterRestart = listRuns(restarted);
    expect(runsAfterRestart).toEqual(runs);
    restarted.close();

    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});
