/**
 * The runtime — the piece that executes the workflow script (D13). Owns
 * paths, the NDJSON sink, the clone lifecycle, and process bookkeeping
 * (before/after `ps` snapshots, per F4). Everything workflow-shaped lives in
 * `workflow.ts`; everything mechanical lives here and in `lib/`.
 *
 * Run with: `bun run src/spike/runtime.ts`
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runAgentStep } from "./lib/agent-step";
import { resetSpikeClone } from "./lib/clone";
import { hostExec } from "./lib/exec";
import { createNdjsonSink } from "./lib/ndjson";
import { implementSlugify, type WorkflowContext } from "./workflow";

const FACTORY_ROOT = join(import.meta.dir, "..", "..");
const FACTORY_DIR = join(FACTORY_ROOT, ".factory");
const CLONE_PATH = join(FACTORY_DIR, "factory-spike");
const RUNS_DIR = join(FACTORY_DIR, "runs");
const MODEL = "opencode-go/deepseek-v4.1-flash";
const AGENT_STEP_TIMEOUT_MS = 5 * 60 * 1000;

async function opencodeProcessSnapshot(): Promise<string> {
  const result = await hostExec(["ps", "-eo", "pid,ppid,cmd"]);
  return result.stdout
    .split("\n")
    .filter((line) => /opencode/i.test(line) && !/grep/.test(line))
    .join("\n");
}

async function main(): Promise<void> {
  const runId = `run-${Date.now()}`;
  const runDir = join(RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });
  const ndjsonPath = join(runDir, "chunks.ndjson");
  const sink = await createNdjsonSink(ndjsonPath);

  console.log(`[runtime] runId=${runId}`);
  console.log(`[runtime] clonePath=${CLONE_PATH}`);
  console.log(`[runtime] ndjsonPath=${ndjsonPath}`);

  console.log("[runtime] resetting clone (wipe + reclone)...");
  await resetSpikeClone(CLONE_PATH);

  const psBefore = await opencodeProcessSnapshot();
  console.log(`[runtime] opencode processes before step:\n${psBefore || "(none)"}`);

  const ctx: WorkflowContext = {
    clonePath: CLONE_PATH,
    agentStep: (prompt) =>
      runAgentStep({
        threadId: runId,
        clonePath: CLONE_PATH,
        model: MODEL,
        prompt,
        sink,
        timeoutMs: AGENT_STEP_TIMEOUT_MS,
      }),
    exec: (command) => hostExec(command, { cwd: CLONE_PATH }),
  };

  console.log("[runtime] running workflow: implementSlugify...");
  const result = await implementSlugify(ctx);

  console.log(
    `[runtime] agent step: chunks=${result.agent.chunkCount} timedOut=${result.agent.timedOut}`,
  );
  console.log(`[runtime] chunk type counts: ${JSON.stringify(result.agent.chunkTypeCounts)}`);
  console.log(
    `[runtime] CUSTOM event names observed: ${JSON.stringify(result.agent.customEventNames)}`,
  );
  console.log(
    `[runtime] bun test exit code: ${result.test.exitCode}\n${result.test.stdout}\n${result.test.stderr}`,
  );

  const psAfter = await opencodeProcessSnapshot();
  console.log(`[runtime] opencode processes after step:\n${psAfter || "(none)"}`);

  const gitStatus = await hostExec(["git", "status", "--porcelain"], {
    cwd: CLONE_PATH,
  });
  const gitDiffStat = await hostExec(["git", "diff", "--stat"], {
    cwd: CLONE_PATH,
  });
  console.log(`[runtime] git status --porcelain:\n${gitStatus.stdout}`);
  console.log(`[runtime] git diff --stat:\n${gitDiffStat.stdout}`);

  const chunkLines = (await readdir(runDir)).includes("chunks.ndjson")
    ? (await Bun.file(ndjsonPath).text()).trim().split("\n").length
    : 0;
  console.log(`[runtime] ndjson line count: ${chunkLines}`);

  console.log("[runtime] done.");
}

await main();
