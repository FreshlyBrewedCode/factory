/**
 * Host-side clone management (D8: Factory clones on the host into a
 * directory it chose, and hands that path to the harness). Generalized from
 * `src/spike/lib/clone.ts` (ADR 0001 §5), which hardcoded the spike's target
 * repo and identity — the CLI now supplies both.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostExec } from "./exec";
import { writeHeadlessPermissions } from "./sandbox-config";

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Wipe `dir` if present, clone `sshUrl` fresh, and set repo-local git
 * identity. Throws with the captured stderr on any failed step so a caller
 * sees exactly which git invocation failed rather than a bare exit code.
 */
export async function resetClone(
  dir: string,
  sshUrl: string,
  identity: GitIdentity,
): Promise<void> {
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }

  const clone = await hostExec(["git", "clone", sshUrl, dir]);
  if (clone.exitCode !== 0) {
    throw new Error(`git clone failed (exit ${clone.exitCode}): ${clone.stderr.trim()}`);
  }

  const config: ReadonlyArray<ReadonlyArray<string>> = [
    ["git", "config", "user.name", identity.name],
    ["git", "config", "user.email", identity.email],
  ];
  for (const args of config) {
    const result = await hostExec(args, { cwd: dir });
    if (result.exitCode !== 0) {
      throw new Error(
        `${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  // Headless permission policy (#24), same as the workspace path.
  await writeHeadlessPermissions(dir);
}
