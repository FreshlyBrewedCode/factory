/**
 * Phase 1 exit criterion, second half: the same workflow that ran live
 * against opencode (see `docs/findings/`, PR #4 on `factory-spike`) also
 * runs green under the corpus-replay adapter in `bun test`.
 *
 * The replay adapter only replays recorded *chunks* (ADR — `src/replay/
 * adapter.ts`'s docstring); it never actually invokes a tool, so it cannot
 * reproduce the file edits the real run made. This fixture stands in for
 * "the agent already edited the tree": the working copy starts pre-seeded
 * with the final (post-implement) file content, while `origin/main` — read
 * separately via `git show` by `seedFileSnapshot` — keeps the original,
 * pre-issue content. That reproduces the exact shape `assertFixStepSurvived`
 * is designed to check, without needing the replay to mutate anything.
 *
 * `ctx.exec` (`bun test`) and `ctx.writeBack` (`git`/`gh`) are not mockable
 * per-run (`src/runtime/run.ts` calls `hostExec` directly), so this test
 * gives them something real to do instead: a local bare repo as `origin`
 * (so push needs no network) and a fake `gh` shell script prepended onto
 * `PATH` for the duration of the test (so `gh pr create` needs no GitHub).
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hostExec } from "../src/lib/exec";
import { createCorpusReplayAdapter } from "../src/replay/adapter";
import { startRun } from "../src/runtime/run";
import implementIssue from "./implement-issue";

const FULL_ROUND_TRIP_CORPUS = `${import.meta.dir}/../test/corpus/run-1789308170212.ndjson`;

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

const FINAL_INDEX = `/** Returns a friendly greeting for the given name. */
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

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

async function git(dir: string, args: ReadonlyArray<string>): Promise<void> {
  const result = await hostExec(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

describe("implement-issue workflow, replayed against the recorded round-trip corpus", () => {
  test("agent steps replay, exec/assert/write-back run for real against a local git fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-implement-issue-test-"));
    const remoteDir = join(root, "remote.git");
    const workDir = join(root, "work");
    const binDir = join(root, "bin");
    const originalPath = process.env.PATH;

    try {
      await hostExec(["git", "init", "--bare", remoteDir]);
      await hostExec(["git", "init", workDir]);
      await git(workDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      await git(workDir, ["config", "user.name", "Factory Test"]);
      await git(workDir, ["config", "user.email", "factory-test@example.com"]);

      mkdirSync(join(workDir, "src"), { recursive: true });
      writeFileSync(join(workDir, "src/index.ts"), GREET_ONLY_INDEX);
      writeFileSync(join(workDir, "src/index.test.ts"), GREET_ONLY_TEST);
      await git(workDir, ["add", "-A"]);
      await git(workDir, ["commit", "-m", "seed: greet only"]);
      await git(workDir, ["remote", "add", "origin", remoteDir]);
      await git(workDir, ["push", "-u", "origin", "main"]);

      // Simulate "the implement/fix steps already edited the tree" — the
      // corpus replay itself cannot, since it only replays chunks.
      writeFileSync(join(workDir, "src/index.ts"), FINAL_INDEX);
      writeFileSync(join(workDir, "src/index.test.ts"), FINAL_TEST);

      mkdirSync(binDir, { recursive: true });
      const fakeGhPath = join(binDir, "gh");
      writeFileSync(fakeGhPath, FAKE_GH_SCRIPT);
      chmodSync(fakeGhPath, 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;

      const events: Array<unknown> = [];
      const handle = startRun(implementIssue, {
        runId: "test-run-corpus-replay",
        dir: workDir,
        input: {
          issueNumber: 1,
          branch: "factory/test-branch",
          repoSlug: "local/fixture",
          baseBranch: "main",
        },
        adapter: createCorpusReplayAdapter(FULL_ROUND_TRIP_CORPUS),
        onEvent: (event) => events.push(event),
      });

      const outcome = await handle.result;

      expect(outcome.outcome).toBe("completed");
      if (outcome.outcome !== "completed") return;
      expect(outcome.output.testAfterImplementExitCode).toBe(0);
      expect(outcome.output.testAfterFixExitCode).toBe(0);
      expect(outcome.output.hostSideStabilityIntact).toBe(true);
      expect(outcome.output.fixStepSurvivalIntact).toBe(true);
      expect(outcome.output.prMetadataMechanism).toBe("extracted");
      expect(outcome.output.prUrl).toBe("https://github.com/local/fixture/pull/1");
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
