/**
 * 0b harness: proves (or disproves) F4's cancellation story across the
 * Effect v4 boundary, with `ps` evidence, not type-level reasoning ("trust
 * `ps`, not the types" — the same methodology `runtime.ts` uses for its
 * own before/after process snapshots).
 *
 * Runs four timed experiments (two per condition) against a real
 * `opencode-go/deepseek-v4.1-flash` agent step, driven through
 * `lib/effect-agent-step.ts`:
 *
 * - A1/A2 (label `abort`, x2): `interruptBehavior: "abort"`. Waits for
 *   genuine chunk flow, snapshots `ps`, calls `Fiber.interrupt`, and checks
 *   whether the finalizer ran (A1) and whether the opencode process is
 *   actually gone afterward (A2).
 * - A3 (label `control`, x2): `interruptBehavior: "none"` — no
 *   interrupt-specific finalizer registered by this module at all. Per F4,
 *   the process should survive; this experiment either confirms that or
 *   flags F4 as wrong for `localProcess`. NOTE: `Stream.fromAsyncIterable`
 *   still calls `.return()` on the underlying async generator by itself
 *   (Effect's own built-in behavior, see `effect-agent-step.ts`'s module
 *   doc) — this experiment measures the *net effect* of that alone,
 *   without any additional `abort()` poke.
 *
 * Every run also answers A4 (fiber exit shape, via `Fiber.await`), A5 (`git
 * status` on the clone afterward), and A6 (elapsed time between
 * `Fiber.interrupt` and the process actually disappearing).
 *
 * Run with: `bun run src/spike/effect-boundary-experiment.ts`
 */

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Exit, Fiber } from "effect";
import { resetSpikeClone } from "./lib/clone";
import { agentStepEffect, type EffectAgentStepResult } from "./lib/effect-agent-step";
import { hostExec } from "./lib/exec";
import { createNdjsonSink } from "./lib/ndjson";

const FACTORY_ROOT = join(import.meta.dir, "..", "..");
const FACTORY_DIR = join(FACTORY_ROOT, ".factory");
const CLONE_PATH = join(FACTORY_DIR, "factory-spike");
const RUNS_DIR = join(FACTORY_DIR, "runs");
const MODEL = "opencode-go/deepseek-v4.1-flash";

/** Long enough that no experiment's interrupt races the agent's own natural
 * completion, short enough that a capped/hung experiment doesn't block the
 * whole harness forever. */
const LONG_RUNNING_PROMPT = `You are working in a git checkout. Using your bash/shell tool, run exactly this command and wait for it to finish before saying anything else:

for i in $(seq 1 200); do echo "boundary-spike tick $i"; sleep 1; done

Do not run any other command first, do not summarize, do not stop early.`;

/** How many chunks must have arrived before we trust the process is really up. */
const CHUNK_FLOW_THRESHOLD = 3;
const CHUNK_FLOW_TIMEOUT_MS = 60_000;
/** Extra grace after the threshold chunk, before the "before" ps snapshot. */
const POST_FLOW_GRACE_MS = 1_500;
/** Cap on the post-interrupt settle-poll loop before we force-kill and move on. */
const SETTLE_TIMEOUT_MS = 30_000;
const SETTLE_POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function opencodeProcessSnapshot(): Promise<string> {
  const result = await hostExec(["ps", "-eo", "pid,ppid,cmd"]);
  return result.stdout
    .split("\n")
    .filter((line) => /opencode/i.test(line) && !/grep/.test(line))
    .join("\n");
}

function extractPids(ps: string): ReadonlyArray<string> {
  return ps
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0])
    .filter((pid): pid is string => pid !== undefined && /^\d+$/.test(pid));
}

interface Logger {
  log(line: string): Promise<void>;
}

async function createLogger(path: string): Promise<Logger> {
  await writeFile(path, "");
  return {
    async log(line: string): Promise<void> {
      console.log(line);
      await appendFile(path, `${line}\n`);
    },
  };
}

interface SettlePoll {
  readonly atMs: number;
  readonly ps: string;
  readonly pidsRemaining: ReadonlyArray<string>;
}

interface FiberExitSummary {
  readonly tag: "Success" | "Failure(interrupted)" | "Failure(other)";
  readonly detail: string;
}

interface ExperimentResult {
  readonly label: string;
  readonly runIndex: number;
  readonly interruptBehavior: "abort" | "none";
  readonly runId: string;
  readonly chunkCountAtInterrupt: number;
  readonly psBeforeInterrupt: string;
  readonly pidsBeforeInterrupt: ReadonlyArray<string>;
  readonly finalizerRan: boolean;
  readonly abortControllerAbortedAfterInterrupt: boolean;
  readonly interruptAwaitedMs: number;
  readonly psImmediatelyAfterInterruptAwaited: string;
  readonly pidsImmediatelyAfterInterruptAwaited: ReadonlyArray<string>;
  readonly settlePolls: ReadonlyArray<SettlePoll>;
  readonly disappearedAtMsSinceInterruptStart: number | null;
  readonly forceKilledPids: ReadonlyArray<string>;
  readonly fiberExit: FiberExitSummary;
  readonly gitStatusAfter: string;
}

async function runExperiment(params: {
  readonly label: string;
  readonly runIndex: number;
  readonly interruptBehavior: "abort" | "none";
  readonly log: (line: string) => Promise<void>;
}): Promise<ExperimentResult> {
  const { label, runIndex, interruptBehavior, log } = params;
  const runId = `effect-boundary-${label}-${runIndex}-${Date.now()}`;

  await log(
    `\n[exp:${label}#${runIndex}] === starting (interruptBehavior=${interruptBehavior}) ===`,
  );
  await log(`[exp:${label}#${runIndex}] resetting clone (wipe + reclone)...`);
  await resetSpikeClone(CLONE_PATH);

  const runDir = join(RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });
  const sink = await createNdjsonSink(join(runDir, "chunks.ndjson"));

  let finalizerRan = false;
  let chunkSeenCount = 0;

  const handle = agentStepEffect({
    step: label,
    threadId: runId,
    clonePath: CLONE_PATH,
    model: MODEL,
    prompt: LONG_RUNNING_PROMPT,
    sink,
    interruptBehavior,
    onChunk: (count) => {
      chunkSeenCount = count;
    },
    onInterruptFinalizer: () => {
      finalizerRan = true;
    },
  });

  const fiber = Effect.runFork(handle.effect);

  const flowDeadline = Date.now() + CHUNK_FLOW_TIMEOUT_MS;
  while (chunkSeenCount < CHUNK_FLOW_THRESHOLD && Date.now() < flowDeadline) {
    await sleep(200);
  }
  if (chunkSeenCount < CHUNK_FLOW_THRESHOLD) {
    await log(
      `[exp:${label}#${runIndex}] WARNING: only saw ${chunkSeenCount} chunks before the ${CHUNK_FLOW_TIMEOUT_MS}ms flow-wait timeout — proceeding anyway.`,
    );
  } else {
    await log(
      `[exp:${label}#${runIndex}] chunk flow confirmed: ${chunkSeenCount} chunks seen. Waiting ${POST_FLOW_GRACE_MS}ms grace before snapshotting.`,
    );
  }
  await sleep(POST_FLOW_GRACE_MS);

  const psBeforeInterrupt = await opencodeProcessSnapshot();
  const pidsBeforeInterrupt = extractPids(psBeforeInterrupt);
  await log(
    `[exp:${label}#${runIndex}] ps BEFORE interrupt (chunks=${chunkSeenCount}, pids=${JSON.stringify(pidsBeforeInterrupt)}):\n${psBeforeInterrupt || "(none)"}`,
  );

  const interruptStartedAt = Date.now();
  await Effect.runPromise(Fiber.interrupt(fiber));
  const interruptAwaitedMs = Date.now() - interruptStartedAt;
  const abortControllerAbortedAfterInterrupt = handle.abortController.signal.aborted;

  const psImmediatelyAfterInterruptAwaited = await opencodeProcessSnapshot();
  const pidsImmediatelyAfterInterruptAwaited = extractPids(psImmediatelyAfterInterruptAwaited);
  await log(
    `[exp:${label}#${runIndex}] Fiber.interrupt awaited in ${interruptAwaitedMs}ms. finalizerRan=${finalizerRan} abortController.aborted=${abortControllerAbortedAfterInterrupt}`,
  );
  await log(
    `[exp:${label}#${runIndex}] ps IMMEDIATELY AFTER awaited interrupt (pids=${JSON.stringify(pidsImmediatelyAfterInterruptAwaited)}):\n${psImmediatelyAfterInterruptAwaited || "(none)"}`,
  );

  const settlePolls: Array<SettlePoll> = [];
  let disappearedAtMsSinceInterruptStart: number | null = null;
  const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < settleDeadline) {
    await sleep(SETTLE_POLL_INTERVAL_MS);
    const ps = await opencodeProcessSnapshot();
    const stillAlive = extractPids(ps);
    const pidsRemaining = pidsBeforeInterrupt.filter((pid) => stillAlive.includes(pid));
    const atMs = Date.now() - interruptStartedAt;
    settlePolls.push({ atMs, ps, pidsRemaining });
    await log(
      `[exp:${label}#${runIndex}] settle poll @${atMs}ms: pidsRemaining=${JSON.stringify(pidsRemaining)}`,
    );
    if (pidsRemaining.length === 0) {
      disappearedAtMsSinceInterruptStart = atMs;
      break;
    }
  }

  const finalPs = await opencodeProcessSnapshot();
  const finalAlive = extractPids(finalPs);
  const finalRemaining = pidsBeforeInterrupt.filter((pid) => finalAlive.includes(pid));
  const forceKilledPids: Array<string> = [];
  if (finalRemaining.length > 0) {
    await log(
      `[exp:${label}#${runIndex}] CAP REACHED after ${SETTLE_TIMEOUT_MS}ms — ${finalRemaining.length} pid(s) still alive, force-killing: ${JSON.stringify(finalRemaining)}`,
    );
    for (const pid of finalRemaining) {
      await hostExec(["kill", "-9", pid]);
      forceKilledPids.push(pid);
    }
    await sleep(500);
  }

  const exit = await Effect.runPromise(Fiber.await(fiber));
  let fiberExit: FiberExitSummary;
  if (Exit.isSuccess(exit)) {
    const value = exit.value as EffectAgentStepResult;
    fiberExit = {
      tag: "Success",
      detail: `chunkCount=${value.chunkCount} durationMs=${value.durationMs}`,
    };
  } else {
    fiberExit = {
      tag: Exit.hasInterrupts(exit) ? "Failure(interrupted)" : "Failure(other)",
      detail: Cause.pretty(exit.cause),
    };
  }
  await log(
    `[exp:${label}#${runIndex}] Fiber.await exit: tag=${fiberExit.tag} detail=${fiberExit.detail.slice(0, 500)}`,
  );

  const gitStatusAfter = (await hostExec(["git", "status", "--porcelain"], { cwd: CLONE_PATH }))
    .stdout;
  await log(
    `[exp:${label}#${runIndex}] git status --porcelain after interrupt:\n${gitStatusAfter || "(clean)"}`,
  );

  return {
    label,
    runIndex,
    interruptBehavior,
    runId,
    chunkCountAtInterrupt: chunkSeenCount,
    psBeforeInterrupt,
    pidsBeforeInterrupt,
    finalizerRan,
    abortControllerAbortedAfterInterrupt,
    interruptAwaitedMs,
    psImmediatelyAfterInterruptAwaited,
    pidsImmediatelyAfterInterruptAwaited,
    settlePolls,
    disappearedAtMsSinceInterruptStart,
    forceKilledPids,
    fiberExit,
    gitStatusAfter,
  };
}

async function main(): Promise<void> {
  const harnessRunId = `harness-${Date.now()}`;
  const runDir = join(RUNS_DIR, harnessRunId);
  await mkdir(runDir, { recursive: true });
  const stdoutLogPath = join(runDir, "stdout.log");
  const resultsPath = join(runDir, "results.json");
  const logger = await createLogger(stdoutLogPath);
  const log = (line: string) => logger.log(line);

  await log(`[harness] harnessRunId=${harnessRunId}`);
  await log(`[harness] stdoutLogPath=${stdoutLogPath}`);
  await log(`[harness] resultsPath=${resultsPath}`);

  const plan: ReadonlyArray<{ label: string; interruptBehavior: "abort" | "none" }> = [
    { label: "abort", interruptBehavior: "abort" },
    { label: "abort", interruptBehavior: "abort" },
    { label: "control", interruptBehavior: "none" },
    { label: "control", interruptBehavior: "none" },
  ];

  const results: Array<ExperimentResult> = [];
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i]!;
    const result = await runExperiment({
      label: entry.label,
      runIndex: i + 1,
      interruptBehavior: entry.interruptBehavior,
      log,
    });
    results.push(result);
  }

  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  await log(`\n[harness] wrote results to ${resultsPath}`);

  await log("\n[harness] === SUMMARY ===");
  for (const r of results) {
    await log(
      `[harness] ${r.label}#${r.runIndex} (${r.interruptBehavior}): finalizerRan=${r.finalizerRan} pidsBefore=${JSON.stringify(r.pidsBeforeInterrupt)} disappearedAtMs=${r.disappearedAtMsSinceInterruptStart} forceKilled=${JSON.stringify(r.forceKilledPids)} fiberExit=${r.fiberExit.tag}`,
    );
  }

  const finalOrphanCheck = await opencodeProcessSnapshot();
  await log(`\n[harness] final orphan check (should be empty):\n${finalOrphanCheck || "(none)"}`);
  if (finalOrphanCheck.trim().length > 0) {
    const orphanPids = extractPids(finalOrphanCheck);
    await log(
      `[harness] force-killing ${orphanPids.length} remaining orphan(s): ${JSON.stringify(orphanPids)}`,
    );
    for (const pid of orphanPids) {
      await hostExec(["kill", "-9", pid]);
    }
  }

  await log("[harness] done.");
}

await main();
