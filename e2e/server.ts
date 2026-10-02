/**
 * S3's playwright backend. One real daemon on a temp sqlite db, so the browser
 * drives the same HTTP + SSE surface a human would. Nothing here mocks
 * `fetch`.
 *
 * Two seeding paths, both into the same store before the server starts:
 *
 *   - **Static corpus.** `createCorpusReplayAdapter` turns a committed
 *     `test/corpus/*.ndjson` into a real event log with no AI in the loop. The
 *     rich ones are the implement-issue round trip, run against a local bare
 *     `origin` and a fake `gh` (the same fixture `e2e/implement-issue.test.ts`
 *     uses): `run-static-acp-replay` from the ACP adapter's recording, and
 *     `run-static-corpus` from the opencode adapter's, for how the SPA reads
 *     logs written before ADR 0013. A second, small run adds ordering/status
 *     variety.
 *   - **Live.** The daemon serves with `createSlowFakeAdapter`, so a
 *     `POST /api/runs` from a test yields a run whose steps arrive over SSE on
 *     a controllable clock.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../src/config";
import { hostExec } from "../src/lib/exec";
import { appendEvent, openStore } from "../src/persistence/store";
import {
  fakeAgents,
  createCorpusReplayAdapter,
  createSlowFakeAdapter,
} from "../src/replay/adapter";
import { makeAgentRuntime } from "../src/runtime/agent-runtime";
import { startRun } from "../src/runtime/run";
import { startDaemon } from "../src/server/daemon";
import { defineWorkflow, Schema } from "../src/workflow";
import echoWorkflow from "../test/fixtures/echo-workflow";
import registryWorkflow from "../test/fixtures/registry-workflow";
import slowWorkflow from "../test/fixtures/slow-workflow";
import implementIssue from "./implement-issue";

/**
 * The POC registry the New-run dialog reads (phase 5 P4): one workflow with
 * single-depth input fields (`registry-test`), one with a nested schema so
 * D33's raw-JSON escape hatch is exercised.
 */
const nestedInputWorkflow = defineWorkflow("nested-input-test", {
  input: Schema.Struct({ spec: Schema.Struct({ name: Schema.String }) }),
  run: async (ctx) => {
    const result = await ctx.agent("step", "irrelevant, replay ignores it");
    return { finalText: result.finalText };
  },
});

/** Recorded by the opencode adapter, before ADR 0013. */
const CORPUS_ROUND_TRIP = join(import.meta.dir, "../test/corpus/run-1789308170212.ndjson");
/** Recorded through the ACP adapter by `scripts/record-corpus.ts`; opencode thinks aloud, so it has reasoning. */
const CORPUS_ACP_ROUND_TRIP = join(
  import.meta.dir,
  "../test/corpus/acp-opencode-implement-issue.ndjson",
);
/** Its first step is all the one-step echo run replays. */
const CORPUS_ONE_STEP = join(import.meta.dir, "../test/corpus/acp-claude-implement-issue.ndjson");

const GREET_ONLY_INDEX = `/** Returns a friendly greeting for the given name. */
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

const GREET_ONLY_TEST = `import { expect, test } from "bun:test";
import { greet } from "./index";

test("greet returns a greeting with the given name", () => {
  expect(greet("World")).toBe("Hello, World!");
});
`;

const FINAL_INDEX = `${GREET_ONLY_INDEX}
/** Converts the given string into a URL-friendly slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`;

const FINAL_TEST = `import { expect, test } from "bun:test";
import { greet, slugify } from "./index";

test("greet returns a greeting with the given name", () => {
  expect(greet("World")).toBe("Hello, World!");
});

test("slugify converts a string into a URL-friendly slug", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
});
`;

const FAKE_GH_SCRIPT = `#!/bin/sh
echo "https://github.com/local/fixture/pull/1"
`;

/** The slow adapter's chunks: a closed assistant message, so each step succeeds. */
const SLOW_CHUNKS = [
  { type: "TEXT_MESSAGE_START" },
  { type: "TEXT_MESSAGE_CONTENT", delta: "working" },
  { type: "TEXT_MESSAGE_END" },
];

async function git(dir: string, args: ReadonlyArray<string>): Promise<void> {
  const result = await hostExec(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function awaitRun(handle: ReturnType<typeof startRun>): Promise<void> {
  await handle.result;
}

async function seedCorpusRuns(root: string, db: ReturnType<typeof openStore>): Promise<string> {
  const remoteDir = join(root, "remote.git");
  const workDir = join(root, "work");
  const binDir = join(root, "bin");
  const originalPath = process.env.PATH;

  await hostExec(["git", "init", "--bare", remoteDir]);
  await hostExec(["git", "init", workDir]);
  await git(workDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(workDir, ["config", "user.name", "Factory E2E"]);
  await git(workDir, ["config", "user.email", "factory-e2e@example.com"]);

  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src/index.ts"), GREET_ONLY_INDEX);
  writeFileSync(join(workDir, "src/index.test.ts"), GREET_ONLY_TEST);
  await git(workDir, ["add", "-A"]);
  await git(workDir, ["commit", "-m", "seed: greet only"]);
  await git(workDir, ["remote", "add", "origin", remoteDir]);
  await git(workDir, ["push", "-u", "origin", "main"]);

  // The replay only reproduces chunks, not the agent's file edits.
  writeFileSync(join(workDir, "src/index.ts"), FINAL_INDEX);
  writeFileSync(join(workDir, "src/index.test.ts"), FINAL_TEST);

  mkdirSync(binDir, { recursive: true });
  const fakeGhPath = join(binDir, "gh");
  writeFileSync(fakeGhPath, FAKE_GH_SCRIPT);
  chmodSync(fakeGhPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;

  await awaitRun(
    startRun(
      implementIssue,
      makeAgentRuntime(fakeAgents(createCorpusReplayAdapter(CORPUS_ROUND_TRIP))),
      {
        runId: "run-static-corpus",
        dir: workDir,
        repo: { slug: "local/fixture", baseBranch: "main" },
        input: { issueNumber: 1 },
        onEvent: (event) => appendEvent(db, event),
      },
    ),
  );

  await Bun.sleep(20);

  // The same round trip as the ACP adapter records it, in its own clone: the
  // run above already wrote back from `workDir`.
  const acpWorkDir = join(root, "work-acp");
  await hostExec(["git", "clone", "-q", "-b", "main", remoteDir, acpWorkDir]);
  await git(acpWorkDir, ["config", "user.name", "Factory E2E"]);
  await git(acpWorkDir, ["config", "user.email", "factory-e2e@example.com"]);
  writeFileSync(join(acpWorkDir, "src/index.ts"), FINAL_INDEX);
  writeFileSync(join(acpWorkDir, "src/index.test.ts"), FINAL_TEST);
  await awaitRun(
    startRun(
      implementIssue,
      makeAgentRuntime(fakeAgents(createCorpusReplayAdapter(CORPUS_ACP_ROUND_TRIP))),
      {
        runId: "run-static-acp-replay",
        dir: acpWorkDir,
        repo: { slug: "local/fixture", baseBranch: "main" },
        input: { issueNumber: 1 },
        onEvent: (event) => appendEvent(db, event),
      },
    ),
  );

  await Bun.sleep(20);

  // A second, cheap run so list ordering has more than one data point.
  await awaitRun(
    startRun(
      echoWorkflow,
      makeAgentRuntime(fakeAgents(createCorpusReplayAdapter(CORPUS_ONE_STEP))),
      {
        runId: "run-static-echo",
        dir: workDir,
        input: {},
        onEvent: (event) => appendEvent(db, event),
      },
    ),
  );

  await Bun.sleep(20);

  // An interrupted run: no terminal event, so the store reports it interrupted
  // and the serving process cannot mark it active.
  const ts = Date.now();
  appendEvent(db, {
    runId: "run-static-interrupted",
    seq: 0,
    ts,
    payload: {
      _tag: "RunStarted",
      workflowId: "implement-issue",
      dir: workDir,
      input: {
        issueNumber: 9,
      },
    },
  });
  appendEvent(db, {
    runId: "run-static-interrupted",
    seq: 1,
    ts: ts + 1,
    payload: { _tag: "ExecStarted", execId: "exec-0", command: ["bun", "test"], cwd: workDir },
  });

  // Issue #14: a parent/child pair, seeded by hand so the SPA can prove the
  // parent ↔ child navigation without the browser dispatching a real run.
  appendEvent(db, {
    runId: "run-static-tree",
    seq: 0,
    ts,
    payload: {
      _tag: "RunStarted",
      workflowId: "implement-issue",
      dir: workDir,
      input: { issueNumber: 3 },
    },
  });
  appendEvent(db, {
    runId: "run-static-tree",
    seq: 1,
    ts,
    payload: {
      _tag: "RunDispatched",
      childRunId: "run-static-tree-child",
      childWorkflowId: "implement-issue",
      input: { issueNumber: 3 },
    },
  });
  appendEvent(db, {
    runId: "run-static-tree",
    seq: 2,
    ts,
    payload: { _tag: "RunFinished", durationMs: 5 },
  });
  appendEvent(db, {
    runId: "run-static-tree-child",
    seq: 0,
    ts,
    payload: {
      _tag: "RunStarted",
      workflowId: "implement-issue",
      dir: workDir,
      input: { issueNumber: 3 },
      parentId: "run-static-tree",
    },
  });
  appendEvent(db, {
    runId: "run-static-tree-child",
    seq: 1,
    ts,
    payload: { _tag: "RunFinished", durationMs: 5 },
  });

  seedAcpRun(db, workDir, ts);

  return remoteDir;
}

/**
 * Issue #65: an agent step as the ACP adapter records it, shaped after the
 * recorded finding-13 Claude run — `acp.usage` chunks while it runs, a tool
 * call whose descriptive title arrives in an `acp.tool-call` chunk, and
 * `AgentStepFinished.context` / `.cost`. A second step is cancelled
 * mid-turn and keeps what it reported.
 */
function seedAcpRun(db: ReturnType<typeof openStore>, dir: string, ts: number): void {
  const runId = "run-static-acp";
  let seq = 0;
  const append = (payload: Parameters<typeof appendEvent>[1]["payload"]) =>
    appendEvent(db, { runId, seq: seq++, ts: ts + seq, payload });
  const chunk = (stepId: string, value: Record<string, unknown>) =>
    append({ _tag: "AgentChunk", stepId, chunkType: String(value.type), chunk: value as never });
  const usage = (stepId: string, used: number, cost?: number) =>
    chunk(stepId, {
      type: "CUSTOM",
      name: "acp.usage",
      value: {
        context: { used, size: 200_000 },
        ...(cost !== undefined && { cost: { amount: cost, currency: "USD" } }),
      },
    });

  append({ _tag: "RunStarted", workflowId: "acp-hello", dir, input: {} });
  append({
    _tag: "AgentStepStarted",
    stepId: "step-0",
    name: "implement",
    agent: "claude",
    model: "haiku",
    prompt: "add multiply to math.ts",
    structured: false,
  });
  chunk("step-0", { type: "RUN_STARTED", runId: "r0", threadId: "t" });
  usage("step-0", 14_874);
  chunk("step-0", { type: "TOOL_CALL_START", toolCallId: "toolu_1", toolCallName: "edit" });
  chunk("step-0", {
    type: "TOOL_CALL_ARGS",
    toolCallId: "toolu_1",
    delta: '{"title":"Edit"}',
    args: '{"title":"Edit"}',
  });
  chunk("step-0", {
    type: "TOOL_CALL_END",
    toolCallId: "toolu_1",
    toolCallName: "edit",
    input: { title: "Edit" },
  });
  chunk("step-0", {
    type: "CUSTOM",
    name: "acp.tool-call",
    value: { toolCallId: "toolu_1", title: "Edit math.ts", input: { file_path: "math.ts" } },
  });
  chunk("step-0", {
    type: "TOOL_CALL_RESULT",
    toolCallId: "toolu_1",
    messageId: "m1",
    content: "The file math.ts has been updated.",
  });
  usage("step-0", 15_305, 0.0391796);
  chunk("step-0", { type: "RUN_FINISHED", runId: "r0", threadId: "t", finishReason: "stop" });
  append({
    _tag: "AgentStepFinished",
    stepId: "step-0",
    name: "implement",
    outcome: "completed",
    chunkCount: 8,
    durationMs: 7_800,
    finalText: "Added multiply.",
    usage: { inputTokens: 3, outputTokens: 120, cachedInputTokens: 36_386, reasoningTokens: 0 },
    context: { used: 15_305, size: 200_000 },
    cost: { amount: 0.0391796, currency: "USD" },
  });
  append({
    _tag: "AgentStepStarted",
    stepId: "step-1",
    name: "review",
    agent: "claude",
    model: "haiku",
    prompt: "review the change",
    structured: false,
  });
  usage("step-1", 9_120);
  append({
    _tag: "AgentStepFinished",
    stepId: "step-1",
    name: "review",
    outcome: "cancelled",
    chunkCount: 1,
    durationMs: 1_200,
    finalText: "",
    context: { used: 9_120, size: 200_000 },
    cost: { amount: 0.0275702, currency: "USD" },
  });
  append({ _tag: "RunCancelled", durationMs: 9_100 });
}

async function main(): Promise<void> {
  const port = Number(process.env.FACTORY_E2E_PORT ?? "5199");
  const dbPath = process.env.FACTORY_E2E_DB ?? join(import.meta.dir, "../.factory/e2e/factory.db");

  mkdirSync(join(dbPath, ".."), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });

  const db = openStore(dbPath);
  let remoteDir: string;
  const root = mkdtempSync(join(tmpdir(), "factory-e2e-"));
  try {
    remoteDir = await seedCorpusRuns(root, db);
  } finally {
    db.close();
  }

  const config = defineConfig({
    repo: {
      sshUrl: remoteDir,
      identity: { name: "Factory E2E", email: "factory-e2e@example.com" },
      baseBranch: "main",
      slug: "local/fixture",
    },
    workflows: [registryWorkflow, nestedInputWorkflow, slowWorkflow],
    workspaceRoot: join(root, "workspaces"),
    maxConcurrentRuns: 5,
    retainedWorkspaces: 10,
    // Issue #17: one schedule for the Schedules page — never due inside a test
    // session (Jan 1, 04:30 UTC/day*), run-on-start off, so the page proves the
    // config display and manual trigger without the scheduler interfering.
    // `registry-test` clones the local remote, so Run now is fully real.
    schedules: [
      {
        id: "e2e-nightly",
        workflow: "registry-test",
        input: { issueNumber: 3 },
        cron: "30 4 1 1 *",
        timezone: "UTC",
      },
    ],
    agent: fakeAgents(createSlowFakeAdapter(SLOW_CHUNKS, 1_000)),
  });
  const { server } = await startDaemon({ dbPath, port, config });
  console.log(`factory e2e: listening on http://localhost:${server.port}`);
}

await main();
