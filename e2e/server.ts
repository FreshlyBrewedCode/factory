/**
 * S3's playwright backend. One real daemon on a temp sqlite db, so the browser
 * drives the same HTTP + SSE surface a human would. Nothing here mocks
 * `fetch`.
 *
 * Two seeding paths, both into the same store before the server starts:
 *
 *   - **Static corpus.** `createCorpusReplayAdapter` turns a committed
 *     `test/corpus/*.ndjson` into a real event log with no AI in the loop. The
 *     rich one is the implement-issue round trip, run against a local bare
 *     `origin` and a fake `gh` (the same fixture `e2e/implement-issue.test.ts`
 *     uses); a second, small run adds ordering/status variety.
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
import { createCorpusReplayAdapter, createSlowFakeAdapter } from "../src/replay/adapter";
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

const CORPUS_ROUND_TRIP = join(import.meta.dir, "../test/corpus/run-1789308170212.ndjson");
const CORPUS_ONE_STEP = join(
  import.meta.dir,
  "../test/corpus/effect-boundary-control-3-1789309633183.ndjson",
);

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
    startRun(implementIssue, {
      runId: "run-static-corpus",
      dir: workDir,
      repo: { slug: "local/fixture", baseBranch: "main" },
      input: { issueNumber: 1 },
      adapter: createCorpusReplayAdapter(CORPUS_ROUND_TRIP),
      onEvent: (event) => appendEvent(db, event),
    }),
  );

  await Bun.sleep(20);

  // A second, cheap run so list ordering has more than one data point.
  await awaitRun(
    startRun(echoWorkflow, {
      runId: "run-static-echo",
      dir: workDir,
      input: {},
      adapter: createCorpusReplayAdapter(CORPUS_ONE_STEP),
      onEvent: (event) => appendEvent(db, event),
    }),
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

  return remoteDir;
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

  const adapter = createSlowFakeAdapter(SLOW_CHUNKS, 1_000);
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
  });
  const { server } = await startDaemon({ dbPath, port, adapter, config });
  console.log(`factory e2e: listening on http://localhost:${server.port}`);
}

await main();
