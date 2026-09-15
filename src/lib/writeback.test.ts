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

import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { hostExec } from "./exec";
import { cleanStrayArtifacts, writeBack, type ExecFn } from "./writeback";
import type { ExecResult } from "./exec";

const FAKE_GH_URL = "https://github.com/local/fixture/pull/1";

const FAKE_GH_OK = `#!/bin/sh
echo "${FAKE_GH_URL}"
`;

const FAKE_GH_PR_EXISTS_ONCE = `#!/bin/sh
state="$GH_COUNT_FILE"
n=$(cat "$state" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$state"
if [ "$n" = "1" ]; then
  echo 'a pull request for branch "factory/pr-collide" already exists' >&2
  exit 1
fi
echo "${FAKE_GH_URL}"
`;

interface CollisionFixture {
  readonly dir: string;
  readonly cleanup: () => void;
}

async function git(dir: string, args: ReadonlyArray<string>): Promise<void> {
  const result = await hostExec(["git", ...args], { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${dir} failed: ${result.stderr}`);
  }
}

async function makeWorkRepo(): Promise<CollisionFixture> {
  const root = mkdtempSync(join(tmpdir(), "factory-writeback-collide-"));
  const remote = join(root, "remote.git");
  const dir = join(root, "work");
  await hostExec(["git", "init", "--bare", remote]);
  await hostExec(["git", "init", "-b", "main", dir]);
  await git(dir, ["config", "user.name", "Factory Test"]);
  await git(dir, ["config", "user.email", "factory-test@example.com"]);
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n");
  await git(dir, ["add", "seed.ts"]);
  await git(dir, ["remote", "add", "origin", remote]);
  await git(dir, ["commit", "-q", "-m", "seed"]);
  return {
    dir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

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

describe("writeBack collision signatures (M4b)", () => {
  function scriptedExec(push: ExecResult, pr: ExecResult): ExecFn {
    let pushCalls = 0;
    return (argv) => {
      const cmd = argv[1] ?? "";
      if (cmd === "status") {
        return Promise.resolve({
          command: argv.join(" "),
          exitCode: 0,
          stdout: " M work.ts\n",
          stderr: "",
        });
      }
      if (cmd === "add" || cmd === "commit" || cmd === "checkout") {
        return Promise.resolve({ command: argv.join(" "), exitCode: 0, stdout: "", stderr: "" });
      }
      if (cmd === "push") {
        pushCalls++;
        return Promise.resolve(pushCalls === 1 ? push : { ...push, exitCode: 0, stderr: "" });
      }
      if (cmd === "pr") return Promise.resolve(pr);
      throw new Error(`unexpected command in test: ${argv.join(" ")}`);
    };
  }

  async function runWriteback(push: ExecResult, pr: ExecResult) {
    return writeBack(
      {
        dir: "/nowhere",
        branch: "factory/hint",
        baseBranch: "main",
        repoSlug: "local/fixture",
        commitMessage: "m",
        prTitle: "t",
        prBody: "b",
        runId: "run-a1b2c3d4",
      },
      scriptedExec(push, pr),
    );
  }

  test("a non-fast-forward rejection is treated as a collision and retried once", async () => {
    const rejected: ExecResult = {
      command: "git push",
      exitCode: 1,
      stdout: "",
      stderr:
        "To git@github.com:acme/widgets.git\n ! [rejected]        factory/hint -> factory/hint (non-fast-forward)\nerror: failed to push some refs",
    };
    const ok: ExecResult = {
      command: "gh pr create",
      exitCode: 0,
      stdout: "https://github.com/local/fixture/pull/9\n",
      stderr: "",
    };
    const result = await runWriteback(rejected, ok);
    expect(result.collided).toBe(true);
    expect(result.branch).toBe("factory/hint-a1b2c3d4");
  });

  test("an auth-failure stderr does not collide and does not retry", async () => {
    const authFailed: ExecResult = {
      command: "git push",
      exitCode: 1,
      stdout: "",
      stderr:
        "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights",
    };
    const skippedPr: ExecResult = {
      command: "(skipped)",
      exitCode: -1,
      stdout: "",
      stderr: "push failed or skipped, pr create skipped",
    };
    const result = await runWriteback(authFailed, skippedPr);
    expect(result.collided).toBe(false);
    expect(result.branch).toBe("factory/hint");
    expect(result.prResult.exitCode).toBe(-1);
  });

  test("a gh auth failure does not collide and does not retry", async () => {
    const pushed: ExecResult = {
      command: "git push",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    const ghAuthFailed: ExecResult = {
      command: "gh pr create",
      exitCode: 1,
      stdout: "",
      stderr: "gh: HTTP 401: Bad credentials (https://api.github.com/graphql)",
    };
    const result = await runWriteback(pushed, ghAuthFailed);
    expect(result.collided).toBe(false);
    expect(result.branch).toBe("factory/hint");
  });
});

describe("writeBack, D32's reactive collision retry", () => {
  const originalPath = process.env.PATH;
  let ghRoot: string | undefined;

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.GH_COUNT_FILE;
    if (ghRoot !== undefined) {
      rmSync(ghRoot, { recursive: true, force: true });
      ghRoot = undefined;
    }
  });

  function useFakeGh(script: string): void {
    ghRoot = mkdtempSync(join(tmpdir(), "factory-writeback-gh-"));
    const bin = join(ghRoot, "bin");
    mkdirSync(bin, { recursive: true });
    const ghPath = join(bin, "gh");
    writeFileSync(ghPath, script);
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.GH_COUNT_FILE = join(ghRoot, "count");
  }

  function makeOptions(dir: string, branch: string, runId: string) {
    return {
      dir,
      branch,
      baseBranch: "main",
      repoSlug: "local/fixture",
      commitMessage: "work happens",
      prTitle: "t",
      prBody: "b",
      runId,
    } as const;
  }

  test("a push rejected because the branch exists remotely retries once on a runId-suffixed branch", async () => {
    useFakeGh(FAKE_GH_OK);
    const fixture = await makeWorkRepo();
    try {
      const rival = mkdtempSync(join(tmpdir(), "factory-writeback-rival-"));
      try {
        await hostExec(["git", "init", "-b", "main", rival]);
        await git(rival, ["config", "user.name", "Rival"]);
        await git(rival, ["config", "user.email", "rival@example.com"]);
        writeFileSync(join(rival, "rival.ts"), "export const rival = 1;\n");
        await git(rival, ["add", "rival.ts"]);
        await git(rival, ["commit", "-q", "-m", "rival work"]);
        await git(rival, ["remote", "add", "origin", join(fixture.dir, "..", "remote.git")]);
        await git(rival, ["push", "-q", "origin", "main:factory/solo"]);
      } finally {
        rmSync(rival, { recursive: true, force: true });
      }

      writeFileSync(join(fixture.dir, "work.ts"), "export const work = 1;\n");
      const exec = (argv: ReadonlyArray<string>) => hostExec(argv, { cwd: fixture.dir });

      const result = await writeBack(
        makeOptions(fixture.dir, "factory/solo", "run-a1b2c3d4"),
        exec,
      );

      expect(result.collided).toBe(true);
      expect(result.branch).toBe("factory/solo-a1b2c3d4");
      expect(result.pushResult.exitCode).toBe(0);
      expect(result.prResult.exitCode).toBe(0);
      expect(result.prUrl).toBe(FAKE_GH_URL);

      const head = await hostExec(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: fixture.dir,
      });
      expect(head.stdout.trim()).toBe("factory/solo-a1b2c3d4");

      const lsRemote = await hostExec(
        ["git", "ls-remote", "origin", "refs/heads/factory/solo-a1b2c3d4"],
        { cwd: fixture.dir },
      );
      expect(lsRemote.stdout).toContain("refs/heads/factory/solo-a1b2c3d4");
    } finally {
      fixture.cleanup();
    }
  }, 20_000);

  test("a 'gh pr create' already-exists failure retries once on a runId-suffixed branch", async () => {
    useFakeGh(FAKE_GH_PR_EXISTS_ONCE);
    const fixture = await makeWorkRepo();
    try {
      writeFileSync(join(fixture.dir, "work.ts"), "export const work = 1;\n");
      const exec = (argv: ReadonlyArray<string>) => hostExec(argv, { cwd: fixture.dir });

      const result = await writeBack(
        makeOptions(fixture.dir, "factory/pr-collide", "run-a1b2c3d4"),
        exec,
      );

      expect(result.collided).toBe(true);
      expect(result.branch).toBe("factory/pr-collide-a1b2c3d4");
      expect(result.pushResult.exitCode).toBe(0);
      expect(result.prResult.exitCode).toBe(0);
      expect(result.prUrl).toBe(FAKE_GH_URL);
    } finally {
      fixture.cleanup();
    }
  }, 20_000);

  test("a clean push opens the PR on the branch it was given and reports it used", async () => {
    useFakeGh(FAKE_GH_OK);
    const fixture = await makeWorkRepo();
    try {
      writeFileSync(join(fixture.dir, "work.ts"), "export const work = 1;\n");
      const exec = (argv: ReadonlyArray<string>) => hostExec(argv, { cwd: fixture.dir });

      const result = await writeBack(
        makeOptions(fixture.dir, "factory/clean", "run-a1b2c3d4"),
        exec,
      );

      expect(result.collided).toBe(false);
      expect(result.branch).toBe("factory/clean");
      expect(result.prUrl).toBe(FAKE_GH_URL);
    } finally {
      fixture.cleanup();
    }
  }, 20_000);
});
