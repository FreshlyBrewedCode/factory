/**
 * Host-side, deterministic git + gh write-back (D9): branch, stage, commit,
 * push, `gh pr create`. Not an agent instruction — Factory composes the
 * branch name and commit message; the agent only ever supplies `{title,
 * body}` for the PR (D11), which is passed in, not generated here.
 *
 * Stray-artifact hazard (ADR 0001 §1 / D16): merely configuring
 * `defineWorkspace(...)` under `localProcessSandbox` leaves a
 * `.tanstack-projected-<hash>` marker file nested under a bogus `data/...`
 * path in the tree, untracked. `cleanStrayArtifacts` removes it (and
 * anything matching the same shape) before anything is staged, and
 * `writeBack` re-checks `git status --porcelain` afterwards and throws
 * rather than silently staging garbage.
 *
 * Adapted from `src/spike/lib/writeback.ts` (ADR 0001 §5): every git/gh
 * invocation now goes through an injected `exec` function rather than
 * `hostExec` directly, so `ctx.writeBack` (which owns the injection) gets
 * per-command `ExecStarted`/`ExecFinished` events for free (ADR 0003).
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult } from "./exec";

export type ExecFn = (argv: ReadonlyArray<string>) => Promise<ExecResult>;

export interface WriteBackOptions {
  readonly dir: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly repoSlug: string;
  readonly commitMessage: string;
  readonly prTitle: string;
  readonly prBody: string;
}

export interface WriteBackResult {
  readonly cleanedArtifacts: ReadonlyArray<string>;
  readonly stagedPaths: ReadonlyArray<string>;
  readonly branchResult: ExecResult;
  readonly commitResult: ExecResult;
  readonly pushResult: ExecResult;
  readonly prResult: ExecResult;
  readonly prUrl: string | null;
}

const STRAY_ARTIFACT_PATTERNS: ReadonlyArray<RegExp> = [/\.tanstack-projected-/, /^data(\/|$)/];

function isStrayPath(path: string): boolean {
  return STRAY_ARTIFACT_PATTERNS.some((re) => re.test(path));
}

/** `git status --porcelain` lines are `XY path` (or `XY old -> new` for renames). */
async function porcelainPaths(dir: string, exec: ExecFn): Promise<ReadonlyArray<string>> {
  const status = await exec(["git", "status", "--porcelain"]);
  return status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim());
}

/**
 * Remove anything matching the known stray-artifact shape from the working
 * tree, based on `git status --porcelain`. Returns the paths it removed.
 */
export async function cleanStrayArtifacts(
  dir: string,
  exec: ExecFn,
): Promise<ReadonlyArray<string>> {
  const paths = await porcelainPaths(dir, exec);
  const stray = paths.filter(isStrayPath);
  for (const path of stray) {
    await rm(join(dir, path), { recursive: true, force: true });
  }
  return stray;
}

function extractUrl(stdout: string): string | null {
  const match = /https:\/\/\S+/.exec(stdout);
  return match ? match[0] : null;
}

const SKIPPED = (reason: string): ExecResult => ({
  command: "(skipped)",
  exitCode: -1,
  stdout: "",
  stderr: reason,
});

/**
 * Branch, stage only intended paths, commit, push, and open a PR. Throws if
 * a stray artifact survives `cleanStrayArtifacts` (a hard rule: nothing from
 * the sandbox-projection bug may reach a commit), or if `git checkout -b`
 * fails outright. Every other step's failure is captured in its `ExecResult`
 * rather than thrown, so a caller can inspect exactly where the chain broke.
 */
export async function writeBack(options: WriteBackOptions, exec: ExecFn): Promise<WriteBackResult> {
  const cleanedArtifacts = await cleanStrayArtifacts(options.dir, exec);

  const remaining = await porcelainPaths(options.dir, exec);
  const stillStray = remaining.filter(isStrayPath);
  if (stillStray.length > 0) {
    throw new Error(
      `stray artifacts survived cleanup, refusing to stage: ${stillStray.join(", ")}`,
    );
  }

  const branchResult = await exec(["git", "checkout", "-b", options.branch]);
  if (branchResult.exitCode !== 0) {
    throw new Error(`git checkout -b ${options.branch} failed: ${branchResult.stderr.trim()}`);
  }

  const stagedPaths = remaining;
  if (stagedPaths.length > 0) {
    const addResult = await exec(["git", "add", "--", ...stagedPaths]);
    if (addResult.exitCode !== 0) {
      throw new Error(`git add failed: ${addResult.stderr.trim()}`);
    }
  }

  const commitResult =
    stagedPaths.length > 0
      ? await exec(["git", "commit", "-m", options.commitMessage])
      : SKIPPED("nothing staged, commit skipped");

  const pushResult =
    commitResult.exitCode === 0
      ? await exec(["git", "push", "-u", "origin", options.branch])
      : SKIPPED("commit failed or skipped, push skipped");

  const prResult =
    pushResult.exitCode === 0
      ? await exec([
          "gh",
          "pr",
          "create",
          "--repo",
          options.repoSlug,
          "--base",
          options.baseBranch,
          "--head",
          options.branch,
          "--title",
          options.prTitle,
          "--body",
          options.prBody,
        ])
      : SKIPPED("push failed or skipped, pr create skipped");

  const prUrl = prResult.exitCode === 0 ? extractUrl(prResult.stdout) : null;

  return { cleanedArtifacts, stagedPaths, branchResult, commitResult, pushResult, prResult, prUrl };
}
