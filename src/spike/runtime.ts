/**
 * The runtime — the piece that executes the workflow script (D13). Owns
 * paths, the NDJSON sink, the clone lifecycle, and process bookkeeping
 * (before/after `ps` snapshots, per F4). Everything workflow-shaped lives in
 * `workflow.ts`; everything mechanical lives here and in `lib/`.
 *
 * 0a-2: runs the full eight-step round trip and prints a PR URL on success.
 * Also persists `.factory/runs/<runId>/summary.json` and
 * `.factory/runs/<runId>/stdout.log` so a run's assertions and timings
 * survive the process exiting — the 0a-1/first-cut 0a-2 run's stdout was
 * only ever in a terminal scrollback and is now unrecoverable, which is
 * exactly the gap this closes.
 *
 * Run with: `bun run src/spike/runtime.ts`
 */

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentStep, type AgentStepResult } from "./lib/agent-step";
import { resetSpikeClone } from "./lib/clone";
import { hostExec } from "./lib/exec";
import { createNdjsonSink } from "./lib/ndjson";
import { fullRoundTrip, type WorkflowContext } from "./workflow";

const FACTORY_ROOT = join(import.meta.dir, "..", "..");
const FACTORY_DIR = join(FACTORY_ROOT, ".factory");
const CLONE_PATH = join(FACTORY_DIR, "factory-spike");
const RUNS_DIR = join(FACTORY_DIR, "runs");
const MODEL = "opencode-go/deepseek-v4.1-flash";
const AGENT_STEP_TIMEOUT_MS = 5 * 60 * 1000;
const REPO_SLUG = "FreshlyBrewedCode/factory-spike";
const BASE_BRANCH = "main";
const ISSUE_NUMBER = 1;

async function opencodeProcessSnapshot(): Promise<string> {
  const result = await hostExec(["ps", "-eo", "pid,ppid,cmd"]);
  return result.stdout
    .split("\n")
    .filter((line) => /opencode/i.test(line) && !/grep/.test(line))
    .join("\n");
}

interface Logger {
  log(line: string): Promise<void>;
}

/** Mirrors every line to stdout AND appends it to `path`, so the run's full
 * console output survives the process exiting (not just terminal
 * scrollback). */
async function createLogger(path: string): Promise<Logger> {
  await writeFile(path, "");
  return {
    async log(line: string): Promise<void> {
      console.log(line);
      await appendFile(path, `${line}\n`);
    },
  };
}

function logStepLines(step: AgentStepResult): Array<string> {
  const lines: Array<string> = [];
  lines.push(
    `[runtime] step=${step.step} chunks=${step.chunkCount} durationMs=${step.durationMs} timedOut=${step.timedOut} runError=${step.runError ?? "none"}`,
  );
  lines.push(`[runtime] step=${step.step} chunkTypeCounts=${JSON.stringify(step.chunkTypeCounts)}`);
  lines.push(
    `[runtime] step=${step.step} customEventNames=${JSON.stringify(step.customEventNames)}`,
  );
  lines.push(
    `[runtime] step=${step.step} finalAssistantText (first 300 chars)=${JSON.stringify(step.finalAssistantText.slice(0, 300))}`,
  );
  if (step.structuredOutput !== undefined) {
    lines.push(
      `[runtime] step=${step.step} structuredOutput=${JSON.stringify(step.structuredOutput)}`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const runId = `run-${Date.now()}`;
  const branch = `factory/issue-${ISSUE_NUMBER}-${runId}`;
  const runDir = join(RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });
  const ndjsonPath = join(runDir, "chunks.ndjson");
  const stdoutLogPath = join(runDir, "stdout.log");
  const summaryPath = join(runDir, "summary.json");
  const sink = await createNdjsonSink(ndjsonPath);
  const logger = await createLogger(stdoutLogPath);
  const log = (line: string) => logger.log(line);

  await log(`[runtime] runId=${runId}`);
  await log(`[runtime] clonePath=${CLONE_PATH}`);
  await log(`[runtime] ndjsonPath=${ndjsonPath}`);
  await log(`[runtime] stdoutLogPath=${stdoutLogPath}`);
  await log(`[runtime] summaryPath=${summaryPath}`);
  await log(`[runtime] branch=${branch}`);

  await log("[runtime] step 1/8: resetting clone (wipe + reclone)...");
  const cloneStart = Date.now();
  await resetSpikeClone(CLONE_PATH);
  const cloneDurationMs = Date.now() - cloneStart;
  await log(`[runtime] step 1/8: clone reset took ${cloneDurationMs}ms`);

  const psBeforeAll = await opencodeProcessSnapshot();
  await log(`[runtime] opencode processes before any agent step:\n${psBeforeAll || "(none)"}`);

  const ctx: WorkflowContext = {
    clonePath: CLONE_PATH,
    agentStep: (opts) =>
      runAgentStep({
        threadId: runId,
        clonePath: CLONE_PATH,
        model: MODEL,
        prompt: opts.prompt,
        step: opts.step,
        sink,
        timeoutMs: AGENT_STEP_TIMEOUT_MS,
        outputSchema: opts.outputSchema,
      }),
    exec: (command) => hostExec(command, { cwd: CLONE_PATH }),
  };

  await log("[runtime] steps 2-7: running workflow: fullRoundTrip...");
  const runStart = Date.now();
  const result = await fullRoundTrip(ctx, {
    branch,
    repoSlug: REPO_SLUG,
    baseBranch: BASE_BRANCH,
    issueNumber: ISSUE_NUMBER,
  });
  const totalRoundTripMs = Date.now() - runStart;
  await log(`[runtime] fullRoundTrip took ${totalRoundTripMs}ms total`);

  for (const line of logStepLines(result.implement)) await log(line);
  await log(
    `[runtime] bun test (after implement) exit=${result.testAfterImplement.exitCode}\n${result.testAfterImplement.stdout}\n${result.testAfterImplement.stderr}`,
  );

  await log(`\n${result.hostSideStabilityAssertion.report}\n`);

  for (const line of logStepLines(result.fix)) await log(line);

  await log(`\n${result.fixStepSurvivalAssertion.report}\n`);

  await log(
    `[runtime] bun test (after fix) exit=${result.testAfterFix.exitCode}\n${result.testAfterFix.stdout}\n${result.testAfterFix.stderr}`,
  );

  for (const line of logStepLines(result.prMetadataStep)) await log(line);
  await log(
    `[runtime] PR metadata mechanism=${result.prMetadata.mechanism} title=${JSON.stringify(result.prMetadata.title)}`,
  );

  const psAfterAgentSteps = await opencodeProcessSnapshot();
  await log(
    `[runtime] opencode processes after all agent steps:\n${psAfterAgentSteps || "(none)"}`,
  );

  await log("[runtime] step 7/8: write-back...");
  await log(
    `[runtime] write-back cleanedArtifacts=${JSON.stringify(result.writeBack.cleanedArtifacts)}`,
  );
  await log(`[runtime] write-back stagedPaths=${JSON.stringify(result.writeBack.stagedPaths)}`);
  await log(
    `[runtime] write-back gitStatusBeforeCommit (must be empty of .tanstack-projected/data):\n${result.writeBack.gitStatusBeforeCommit || "(clean)"}`,
  );
  await log(
    `[runtime] write-back branch exit=${result.writeBack.branchResult.exitCode} stderr=${result.writeBack.branchResult.stderr.trim()}`,
  );
  await log(
    `[runtime] write-back commit exit=${result.writeBack.commitResult.exitCode} stdout=${result.writeBack.commitResult.stdout.trim()} stderr=${result.writeBack.commitResult.stderr.trim()}`,
  );
  await log(
    `[runtime] write-back push exit=${result.writeBack.pushResult.exitCode} stdout=${result.writeBack.pushResult.stdout.trim()} stderr=${result.writeBack.pushResult.stderr.trim()}`,
  );
  await log(
    `[runtime] write-back pr create exit=${result.writeBack.prResult.exitCode} stdout=${result.writeBack.prResult.stdout.trim()} stderr=${result.writeBack.prResult.stderr.trim()}`,
  );

  const psAfterAll = await opencodeProcessSnapshot();
  await log(`[runtime] opencode processes after full run:\n${psAfterAll || "(none)"}`);

  const chunkLines = (await Bun.file(ndjsonPath).text()).trim().split("\n").length;
  await log(`[runtime] step 8/8: ndjson line count (all steps): ${chunkLines}`);

  if (result.writeBack.prUrl) {
    await log(`\nPR_URL=${result.writeBack.prUrl}\n`);
  } else {
    await log("\n[runtime] NO PR URL — write-back did not succeed. See write-back output above.\n");
  }

  const summary = {
    runId,
    branch,
    clonePath: CLONE_PATH,
    ndjsonPath,
    stdoutLogPath,
    model: MODEL,
    repoSlug: REPO_SLUG,
    timings: {
      cloneResetMs: cloneDurationMs,
      totalRoundTripMs,
      implementMs: result.implement.durationMs,
      fixMs: result.fix.durationMs,
      prMetadataMs: result.prMetadataStep.durationMs,
    },
    ndjsonLineCount: chunkLines,
    steps: {
      implement: {
        chunkCount: result.implement.chunkCount,
        chunkTypeCounts: result.implement.chunkTypeCounts,
        customEventNames: result.implement.customEventNames,
        timedOut: result.implement.timedOut,
        runError: result.implement.runError ?? null,
      },
      fix: {
        chunkCount: result.fix.chunkCount,
        chunkTypeCounts: result.fix.chunkTypeCounts,
        customEventNames: result.fix.customEventNames,
        timedOut: result.fix.timedOut,
        runError: result.fix.runError ?? null,
      },
      prMetadata: {
        chunkCount: result.prMetadataStep.chunkCount,
        chunkTypeCounts: result.prMetadataStep.chunkTypeCounts,
        customEventNames: result.prMetadataStep.customEventNames,
        timedOut: result.prMetadataStep.timedOut,
        runError: result.prMetadataStep.runError ?? null,
        structuredOutput: result.prMetadataStep.structuredOutput ?? null,
      },
    },
    testAfterImplement: {
      exitCode: result.testAfterImplement.exitCode,
    },
    testAfterFix: {
      exitCode: result.testAfterFix.exitCode,
    },
    hostSideStabilityAssertion: {
      intact: result.hostSideStabilityAssertion.intact,
      report: result.hostSideStabilityAssertion.report,
    },
    fixStepSurvivalAssertion: {
      intact: result.fixStepSurvivalAssertion.intact,
      report: result.fixStepSurvivalAssertion.report,
      files: result.fixStepSurvivalAssertion.files,
    },
    prMetadata: result.prMetadata,
    writeBack: {
      cleanedArtifacts: result.writeBack.cleanedArtifacts,
      stagedPaths: result.writeBack.stagedPaths,
      prUrl: result.writeBack.prUrl,
    },
    opencodeProcesses: {
      beforeAll: psBeforeAll,
      afterAgentSteps: psAfterAgentSteps,
      afterAll: psAfterAll,
    },
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await log(`[runtime] wrote summary to ${summaryPath}`);

  await log("[runtime] done.");
}

await main();
