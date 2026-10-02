/**
 * Host-side, deterministic git + gh write-back (D9): branch, stage, commit,
 * push, `gh pr create`. Not an agent instruction — the agent's hint decides
 * the branch name and supplies the PR metadata (D32), while the commit
 * message and the repo slug / base branch arrive from the caller: the
 * workflow and the run environment (config) respectively.
 *
 * Adapted from `src/spike/lib/writeback.ts` (ADR 0001 §5): every git/gh
 * invocation now goes through an injected `exec` function rather than
 * `hostExec` directly, so `ctx.writeBack` (which owns the injection) gets
 * per-command `ExecStarted`/`ExecFinished` events for free (ADR 0003).
 */

import type { ExecFn, ExecResult } from "./exec";

// Re-exported for existing importers; `ExecFn` now lives in `./exec` so the
// provisioning path (workspace.ts) and write-back share one seam type.
export type { ExecFn } from "./exec";

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
  readonly stagedPaths: ReadonlyArray<string>;
  readonly branchResult: ExecResult;
  readonly commitResult: ExecResult;
  readonly pushResult: ExecResult;
  readonly prResult: ExecResult;
  readonly prUrl: string | null;
}

/**
 * `git status --porcelain` lines are `XY path` (or `XY old -> new` for renames).
 * `--untracked-files=all` lists the files inside a wholly-new untracked
 * directory rather than one `?? dir/` line, so `stagedPaths` names every file
 * the commit carries.
 */
async function porcelainPaths(dir: string, exec: ExecFn): Promise<ReadonlyArray<string>> {
  const status = await exec(["git", "status", "--porcelain", "--untracked-files=all"]);
  return status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim());
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
 * Branch, stage the tree's changes, commit, push, and open a PR. Throws if
 * `git checkout -b` or `git add` fails outright. Every other step's failure is captured in its `ExecResult`
 * rather than thrown, so a caller can inspect exactly where the chain broke.
 *
 * D32's collision handling is reactive: push the name it was given; only if
 * the push is rejected because the branch exists remotely, or `gh pr create`
 * reports a PR already exists for it, re-branch onto `branch-<short runId>`
 * and retry once. The result carries the branch actually used.
 */
export async function writeBack(options: WriteBackOptions, exec: ExecFn): Promise<WriteBackResult> {
  const stagedPaths = await porcelainPaths(options.dir, exec);

  const attempt = async (
    branch: string,
    allowPushWithoutNewCommit: boolean,
  ): Promise<Omit<WriteBackResult, "collided" | "stagedPaths">> => {
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
    return { ...first, collided: false, stagedPaths };
  }

  const retry = await attempt(collisionBranch(options.branch, options.runId), true);
  return { ...retry, collided: true, stagedPaths };
}
