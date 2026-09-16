/**
 * D28's per-run working trees (ADR 0005): every run gets
 * `<workspaceRoot>/<runId>/`, cloned locally from a bare mirror
 * `<workspaceRoot>/.mirror.git` that is refreshed from the configured
 * `sshUrl` before each allocation. The last N trees are retained
 * evicted-oldest-first — the moment a tree is worth inspecting is exactly
 * the moment a run failed.
 *
 * Scratch workspaces (issue #13) skip the mirror entirely: a `scratch`
 * allocation is just an empty `<workspaceRoot>/<runId>/` directory, and it
 * neither participates in nor consumes retention — leftover scratch dirs are
 * never eviction candidates, so they cannot evict a clone workspace.
 *
 * Concurrency note: two allocations can refresh the same mirror at once, so
 * mirror maintenance is serialized behind a promise queue keyed by mirror
 * path; the per-run clone and eviction touch distinct runId directories and
 * are safe to run concurrently.
 *
 * Host command execution arrives as an injected `exec` function (the
 * `ExecFn`-injection pattern, as in `writeBack`) — defaulting to `hostExec`,
 * with no behaviour change — so a future non-host sandbox decides whether a
 * non-host workspace is plumbing or a rewrite.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitIdentity } from "./clone";
import { hostExec, type ExecFn, type ExecResult } from "./exec";
import type { WorkspaceKind } from "../workflow";
import { writeHeadlessPermissions } from "./sandbox-config";

const MIRROR_DIR = ".mirror.git";

export interface WorkspaceAllocationInput {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly sshUrl: string;
  readonly identity: GitIdentity;
  readonly retainedWorkspaces: number;
  /**
   * Issue #13's provisioning kind. `clone` (the default) mirrors + clones;
   * `scratch` is an empty directory with no mirror refresh and no clone.
   */
  readonly kind?: WorkspaceKind;
  /**
   * Directory names (runIds) of **scratch** workspaces. They are never eviction
   * candidates and never count toward `retainedWorkspaces` — a scratch leftover
   * (a failed run's dir, kept for inspection) must not push a clone tree out.
   */
  readonly scratchEntries?: ReadonlySet<string>;
  /**
   * Directory names (runIds) eviction must never remove — the trees of runs
   * this process still holds. Without this, retention could delete a running
   * run's tree when retainedWorkspaces is near maxConcurrentRuns.
   */
  readonly protectedEntries?: ReadonlyArray<string>;
  /** Injectable host-exec seam; defaults to `hostExec` (no behaviour change). */
  readonly exec?: ExecFn;
}

const refreshGates = new Map<string, Promise<void>>();

function enqueueRefresh(mirrorPath: string, task: () => Promise<void>): Promise<void> {
  const prior = refreshGates.get(mirrorPath) ?? Promise.resolve();
  const next = prior.then(task, task);
  refreshGates.set(mirrorPath, next);
  return next;
}

async function refreshMirror(mirrorPath: string, sshUrl: string, exec: ExecFn): Promise<void> {
  let result: ExecResult;
  if (existsSync(mirrorPath)) {
    result = await exec(["git", "remote", "update", "--prune"], { cwd: mirrorPath });
  } else {
    result = await exec(["git", "clone", "--mirror", sshUrl, mirrorPath]);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `workspace mirror refresh failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

export async function allocateWorkspace(input: WorkspaceAllocationInput): Promise<string> {
  const {
    runId,
    workspaceRoot,
    sshUrl,
    identity,
    retainedWorkspaces,
    kind = "clone",
    scratchEntries,
    protectedEntries,
    exec = hostExec,
  } = input;

  await mkdir(workspaceRoot, { recursive: true });

  const dir = join(workspaceRoot, runId);

  if (kind === "scratch") {
    // No mirror refresh, no clone, no identity — just a path (issue #13).
    // Scratch workspaces never participate in retention, so no eviction runs.
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
    await mkdir(dir, { recursive: true });
    return dir;
  }

  const mirrorPath = join(workspaceRoot, MIRROR_DIR);

  await enqueueRefresh(mirrorPath, () => refreshMirror(mirrorPath, sshUrl, exec));

  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }

  const clone = await exec(["git", "clone", mirrorPath, dir]);
  if (clone.exitCode !== 0) {
    throw new Error(`workspace clone failed (exit ${clone.exitCode}): ${clone.stderr.trim()}`);
  }

  // `git clone <mirror> dir` points the clone's `origin` at the mirror, which
  // would send D9's `git push -u origin <branch>` straight into the local
  // cache and never onto the real remote. Re-point `origin` at the configured
  // sshUrl: afterwards the mirror is only the source of the initial clone —
  // both fetches and write-back go straight to the remote the config names
  // (D27/D28). The mirror is refreshed before each allocation, so its content
  // tracks the remote well enough that a post-clone fetch from it would be
  // redundant.
  const reorigin = await exec(["git", "remote", "set-url", "origin", sshUrl], { cwd: dir });
  if (reorigin.exitCode !== 0) {
    throw new Error(
      `git remote set-url origin failed (exit ${reorigin.exitCode}): ${reorigin.stderr.trim()}`,
    );
  }

  for (const args of [
    ["git", "config", "user.name", identity.name] as const,
    ["git", "config", "user.email", identity.email] as const,
  ]) {
    const result = await exec([...args], { cwd: dir });
    if (result.exitCode !== 0) {
      throw new Error(
        `${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  // Headless permission policy (#24): the sandboxed serve must never park a
  // turn on a permission ask. Guarded so an injected test fake (which spawns
  // nothing and therefore leaves `dir` absent) does not fail the allocation.
  if (existsSync(dir)) {
    await writeHeadlessPermissions(dir);
  }

  await evictOldWorkspaces(
    workspaceRoot,
    retainedWorkspaces,
    protectedEntries,
    scratchEntries ?? new Set(),
  );
  return dir;
}

/**
 * Retain the last `retainedWorkspaces` trees, evicting oldest-first. The
 * mirror directory is never a candidate, neither is anything named in
 * `protectedEntries` — an active run's tree survives even when retention
 * would otherwise pick it — and neither are `scratchEntries` (issue #13):
 * leftover scratch directories are neither eviction candidates nor counted
 * toward `retainedWorkspaces`, so they cannot evict a clone workspace.
 */
export async function evictOldWorkspaces(
  workspaceRoot: string,
  retainedWorkspaces: number,
  protectedEntries: ReadonlyArray<string> = [],
  scratchEntries: ReadonlySet<string> = new Set(),
): Promise<ReadonlyArray<string>> {
  const protectedSet = new Set(protectedEntries);
  const entries = readdirSync(workspaceRoot).filter(
    (entry) => entry !== MIRROR_DIR && !protectedSet.has(entry) && !scratchEntries.has(entry),
  );
  const evicted: Array<string> = [];
  if (entries.length <= retainedWorkspaces) return evicted;

  const withTimes = entries
    .map((entry) => ({ entry, mtime: statSync(join(workspaceRoot, entry)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  while (withTimes.length > retainedWorkspaces) {
    const oldest = withTimes.shift();
    if (oldest === undefined) break;
    await rm(join(workspaceRoot, oldest.entry), { recursive: true, force: true });
    evicted.push(oldest.entry);
  }
  return evicted;
}
