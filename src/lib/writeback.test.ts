/**
 * Regression test for the bug the live phase-3 dispatch run against
 * factory-spike#1 actually shipped: `cleanStrayArtifacts` only matches
 * individual file paths from `git status --porcelain`, but plain
 * `--porcelain` collapses a wholly-new untracked directory into one
 * `?? dir/` line instead of listing the files inside it. A
 * `.tanstack-projected-*` marker nested under a bogus, never-before-seen
 * directory (exactly what D16's concatenated-absolute-path bug produces)
 * slipped past `isStrayPath` and reached a real commit — PR #5 on
 * FreshlyBrewedCode/factory-spike carries it. See ADR 0004 references /
 * `docs/findings/6-live-dispatch-run.md`.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hostExec } from "./exec";
import { cleanStrayArtifacts } from "./writeback";

describe("cleanStrayArtifacts", () => {
  test("removes a stray marker nested under a wholly-new untracked directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-writeback-test-"));
    try {
      await hostExec(["git", "init", "-q"], { cwd: dir });

      // `git status` works fine against an unborn HEAD (no commits yet), which
      // sidesteps needing a git identity configured just for this test.
      // Exactly the shape D16 produces: an absolute host path concatenated
      // onto the workspace root, landing as a nested relative directory no
      // prior `git status` has ever seen.
      const strayDir = join(dir, "tmp/factory-live-dispatch/work/issue-1");
      mkdirSync(strayDir, { recursive: true });
      writeFileSync(join(strayDir, ".tanstack-projected-abc123"), "");

      const exec = (argv: ReadonlyArray<string>) => hostExec(argv, { cwd: dir });
      const cleaned = await cleanStrayArtifacts(dir, exec);

      expect(cleaned).toEqual([
        "tmp/factory-live-dispatch/work/issue-1/.tanstack-projected-abc123",
      ]);
      expect(existsSync(join(strayDir, ".tanstack-projected-abc123"))).toBe(false);

      const status = await exec(["git", "status", "--porcelain", "--untracked-files=all"]);
      expect(status.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
