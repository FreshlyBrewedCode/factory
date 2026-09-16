/**
 * The headless permission policy (#24): sandbox `opencode serve` processes
 * must never ask for a permission nobody can answer. opencode 1.18's
 * permission asks are read by nobody headless — and the adapter's reactive
 * permission handler cannot even see them (ai-opencode 0.4.5 listens for the
 * removed `permission.updated` event; 1.18 emits `permission.asked`) — so an
 * ask is a permanent silent deadlock of the run, its WIP slot, and its
 * workspace.
 *
 * `allocateWorkspace`/`resetClone` write `opencode.json` into every run tree
 * with `permission: {"*": "allow"}`, verified against opencode's
 * `PermissionConfig` schema (`"*"`, `"allow"`, and every category including
 * `external_directory` are accepted keys). The tree is a throwaway sandbox
 * clone where `gh`/`git` already run host-side; the asks this eliminates are
 * largely operator-imposed (`external_directory` on the D36 parent path).
 *
 * The file is a local artifact, not part of the run's work: register it in
 * the clone's `.git/info/exclude` so `writeBack`'s whole-tree staging never
 * ships it into a commit.
 */

import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_FILENAME = "opencode.json";

const CONFIG_CONTENT = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { "*": "allow" },
});

export async function writeHeadlessPermissions(dir: string): Promise<void> {
  await writeFile(join(dir, CONFIG_FILENAME), `${CONFIG_CONTENT}\n`);

  const excludePath = join(dir, ".git", "info", "exclude");
  await appendFile(
    excludePath,
    `\n# factory: local artifact, never staged (#24)\n${CONFIG_FILENAME}`,
  );
}
