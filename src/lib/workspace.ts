/**
 * D28's per-run working trees (ADR 0005): every run gets
 * `<workspaceRoot>/<runId>/`, cloned locally from a bare mirror
 * `<workspaceRoot>/.mirror.git` that is refreshed from the configured
 * `sshUrl` before each allocation. The last N trees are retained
 * evicted-oldest-first — the moment a tree is worth inspecting is exactly
 * the moment a run failed.
 *
 * Concurrency note: two allocations can refresh the same mirror at once, so
 * mirror maintenance is serialized behind a promise queue keyed by mirror
 * path; the per-run clone and eviction touch distinct runId directories and
 * are safe to run concurrently.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitIdentity } from "./clone";
import { hostExec, type ExecResult } from "./exec";

const MIRROR_DIR = ".mirror.git";

export interface WorkspaceAllocationInput {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly sshUrl: string;
  readonly identity: GitIdentity;
  readonly retainedWorkspaces: number;
  /**
   * Directory names (runIds) eviction must never remove — the trees of runs
   * this process still holds. Without this, retention could delete a running
   * run's tree when retainedWorkspaces is near maxConcurrentRuns.
   */
  readonly protectedEntries?: ReadonlyArray<string>;
}

const refreshGates = new Map<string, Promise<void>>();

function enqueueRefresh(mirrorPath: string, task: () => Promise<void>): Promise<void> {
  const prior = refreshGates.get(mirrorPath) ?? Promise.resolve();
  const next = prior.then(task, task);
  refreshGates.set(mirrorPath, next);
  return next;
}

async function refreshMirror(mirrorPath: string, sshUrl: string): Promise<void> {
  let result: ExecResult;
  if (existsSync(mirrorPath)) {
    result = await hostExec(["git", "remote", "update", "--prune"], { cwd: mirrorPath });
  } else {
    result = await hostExec(["git", "clone", "--mirror", sshUrl, mirrorPath]);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `workspace mirror refresh failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

export async function allocateWorkspace(input: WorkspaceAllocationInput): Promise<string> {
  const { runId, workspaceRoot, sshUrl, identity, retainedWorkspaces, protectedEntries } = input;

  await mkdir(workspaceRoot, { recursive: true });
  const mirrorPath = join(workspaceRoot, MIRROR_DIR);

  await enqueueRefresh(mirrorPath, () => refreshMirror(mirrorPath, sshUrl));

  const dir = join(workspaceRoot, runId);
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }

  const clone = await hostExec(["git", "clone", mirrorPath, dir]);
  if (clone.exitCode !== 0) {
    throw new Error(`workspace clone failed (exit ${clone.exitCode}): ${clone.stderr.trim()}`);
  }

  // `git clone <mirror> dir` points the clone's `origin` at the mirror, which
  // would send D9's `git push -u origin <branch>` straight into the local
  // cache and never onto the real remote. Re-point `origin` at the configured
  // sshUrl: fetches still hit the mirror (refreshed at the step above), but
  // write-back goes to the remote the config names (D27/D28).
  const reorigin = await hostExec(["git", "remote", "set-url", "origin", sshUrl], { cwd: dir });
  if (reorigin.exitCode !== 0) {
    throw new Error(
      `git remote set-url origin failed (exit ${reorigin.exitCode}): ${reorigin.stderr.trim()}`,
    );
  }

  for (const args of [
    ["git", "config", "user.name", identity.name] as const,
    ["git", "config", "user.email", identity.email] as const,
  ]) {
    const result = await hostExec([...args], { cwd: dir });
    if (result.exitCode !== 0) {
      throw new Error(
        `${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  await evictOldWorkspaces(workspaceRoot, retainedWorkspaces, protectedEntries);
  return dir;
}

/**
 * Retain the last `retainedWorkspaces` trees, evicting oldest-first. The
 * mirror directory is never a candidate, and neither is anything named in
 * `protectedEntries` — an active run's tree survives even when retention
 * would otherwise pick it.
 */
export async function evictOldWorkspaces(
  workspaceRoot: string,
  retainedWorkspaces: number,
  protectedEntries: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<string>> {
  const protectedSet = new Set(protectedEntries);
  const entries = readdirSync(workspaceRoot).filter(
    (entry) => entry !== MIRROR_DIR && !protectedSet.has(entry),
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
