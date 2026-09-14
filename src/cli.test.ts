import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { getRunEvents, listRuns, openStore } from "./persistence/store";
import { createSlowFakeAdapter } from "./replay/adapter";
import { runCli } from "./cli";

const ECHO_WORKFLOW = `${import.meta.dir}/../test/fixtures/echo-workflow.ts`;

describe("runCli", () => {
  test("runs a workflow against an injected adapter and writes an NDJSON event log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-cli-test-"));
    const outPath = join(dir, "events.ndjson");

    const exitCode = await runCli({
      workflowPath: ECHO_WORKFLOW,
      input: {},
      dir,
      outPath,
      dbPath: join(dir, "factory.db"),
      adapter: createSlowFakeAdapter(
        [
          { type: "TEXT_MESSAGE_START" },
          { type: "TEXT_MESSAGE_CONTENT", delta: "hi" },
          { type: "TEXT_MESSAGE_END" },
        ],
        1,
      ),
    });

    expect(exitCode).toBe(0);

    const lines = readFileSync(outPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { payload: { _tag: string } });

    const tags = lines.map((line) => line.payload._tag);
    expect(tags).toContain("RunStarted");
    expect(tags).toContain("AgentStepFinished");
    expect(tags).toContain("RunFinished");

    const db = openStore(join(dir, "factory.db"));
    const runs = listRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("RunFinished");
    const persistedTags: string[] = getRunEvents(db, runs[0]?.runId ?? "").map(
      (e) => e.payload._tag,
    );
    expect(persistedTags).toEqual(tags);
    db.close();

    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a workflow module with no default export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-cli-test-"));
    const outPath = join(dir, "events.ndjson");

    let thrown: unknown;
    try {
      await runCli({
        workflowPath: `${import.meta.dir}/events.ts`,
        input: {},
        dir,
        outPath,
        dbPath: join(dir, "factory.db"),
        adapter: createSlowFakeAdapter([], 1),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/no default defineWorkflow/);

    rmSync(dir, { recursive: true, force: true });
  });
});
