/**
 * Host-side, deterministic git + gh write-back (D9): branch, stage, commit,
 * push, `gh pr create`. Not an agent instruction — the agent's hint decides
 * the branch name and supplies the PR metadata (D32), while the commit
 * message and the repo slug / base branch arrive from the caller: the
 * workflow and the run environment (config) respectively.
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
  readonly runId: string;
}

export interface WriteBackResult {
  /** The branch write-back actually landed on (D32: differs from the input only on collision). */
  readonly branch: string;
  /** Whether the runId-suffixed retry happened because the first push or `gh pr create` collided. */
  readonly collided: boolean;
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

/**
 * `git status --porcelain` lines are `XY path` (or `XY old -> new` for renames).
 * `--untracked-files=all` is required, not the default: for a wholly-new
 * untracked directory, plain `--porcelain` collapses it to one `?? dir/` line
 * instead of listing the files inside, which let a nested
 * `.tanstack-projected-*` marker (D16) slip past `isStrayPath` undetected and
 * ship into a real commit — the pattern only ever matches individual paths.
 */
async function porcelainPaths(dir: string, exec: ExecFn): Promise<ReadonlyArray<string>> {
  const status = await exec(["git", "status", "--porcelain", "--untracked-files=all"]);
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
 * D32's collision signatures, matched concretely: a push the remote actually
 * rejected (non-fast-forward — the branch already exists with different
 * history), and `gh pr create`'s own "already exists" message. Anything else
 * — an auth failure, a network error, a permission denial — must NOT trigger
 * the rename-and-retry, or a credentials problem would turn into a spray of
 * runId-suffixed branches.
 */
function isPushRejected(result: ExecResult): boolean {
  if (result.exitCode === 0) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return /! \[(?:remote )?rejected\]|non-fast-forward/.test(output);
}

function isPrAlreadyExists(result: ExecResult): boolean {
  return (
    result.exitCode !== 0 &&
    /pull request for branch .*already exists/.test(`${result.stdout}\n${result.stderr}`)
  );
}

/**
 * The retry branch name: the agent's hint plus a short, run-unique fragment,
 * so two concurrent runs colliding on the same hint resolve deterministically
 * rather than by race (D32).
 */
function collisionBranch(branch: string, runId: string): string {
  return `${branch}-${runId.replace(/^run-/, "").slice(0, 8)}`;
}

/**
 * Branch, stage only intended paths, commit, push, and open a PR. Throws if
 * a stray artifact survives `cleanStrayArtifacts` (a hard rule: nothing from
 * the sandbox-projection bug may reach a commit), or if `git checkout -b`
 * fails outright. Every other step's failure is captured in its `ExecResult`
 * rather than thrown, so a caller can inspect exactly where the chain broke.
 *
 * D32's collision handling is reactive: push the name it was given; only if
 * the push is rejected because the branch exists remotely, or `gh pr create`
 * reports a PR already exists for it, re-branch onto `branch-<short runId>`
 * and retry once. The result carries the branch actually used.
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

  const stagedPaths = remaining;

  const attempt = async (
    branch: string,
    allowPushWithoutNewCommit: boolean,
  ): Promise<Omit<WriteBackResult, "collided" | "cleanedArtifacts" | "stagedPaths">> => {
    const branchResult = await exec(["git", "checkout", "-b", branch]);
    if (branchResult.exitCode !== 0) {
      throw new Error(`git checkout -b ${branch} failed: ${branchResult.stderr.trim()}`);
    }

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

    const canPush =
      allowPushWithoutNewCommit || (stagedPaths.length > 0 && commitResult.exitCode === 0);
    const pushResult = canPush
      ? await exec(["git", "push", "-u", "origin", branch])
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
            branch,
            "--title",
            options.prTitle,
            "--body",
            options.prBody,
          ])
        : SKIPPED("push failed or skipped, pr create skipped");

    const prUrl = prResult.exitCode === 0 ? extractUrl(prResult.stdout) : null;
    return { branch, branchResult, commitResult, pushResult, prResult, prUrl };
  };

  const first = await attempt(options.branch, false);
  const collided = isPushRejected(first.pushResult) || isPrAlreadyExists(first.prResult);
  if (!collided) {
    return { ...first, collided: false, cleanedArtifacts, stagedPaths };
  }

  const retry = await attempt(collisionBranch(options.branch, options.runId), true);
  return { ...retry, collided: true, cleanedArtifacts, stagedPaths };
}
