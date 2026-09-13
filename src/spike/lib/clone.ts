/**
 * Host-side clone management for the spike target repo (D8: Factory clones
 * on the host into a directory it chose, and hands that path to the
 * harness). Re-runnable: wipes any existing clone and re-clones from
 * scratch, then sets git identity repo-locally (per STATUS.md's "Host
 * environment" table — identity is per-repo, not global, on this machine).
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostExec } from "./exec";

export const SPIKE_REPO_SSH_URL = "git@github.com:FreshlyBrewedCode/factory-spike.git";
export const SPIKE_GIT_USER_NAME = "FreshlyBrewedCode";
export const SPIKE_GIT_USER_EMAIL = "karl@git.frebreco.de";

/**
 * Wipe `clonePath` if present, clone the spike repo fresh, and set repo-local
 * git identity. Throws with the captured stderr on any failed step so a
 * caller sees exactly which git invocation failed rather than a bare exit
 * code.
 */
export async function resetSpikeClone(clonePath: string): Promise<void> {
  if (existsSync(clonePath)) {
    await rm(clonePath, { recursive: true, force: true });
  }

  const clone = await hostExec(["git", "clone", SPIKE_REPO_SSH_URL, clonePath]);
  if (clone.exitCode !== 0) {
    throw new Error(`git clone failed (exit ${clone.exitCode}): ${clone.stderr.trim()}`);
  }

  const identity: ReadonlyArray<ReadonlyArray<string>> = [
    ["git", "config", "user.name", SPIKE_GIT_USER_NAME],
    ["git", "config", "user.email", SPIKE_GIT_USER_EMAIL],
  ];
  for (const args of identity) {
    const result = await hostExec(args, { cwd: clonePath });
    if (result.exitCode !== 0) {
      throw new Error(
        `${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }
}
