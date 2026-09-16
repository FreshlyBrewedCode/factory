import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExecResult } from "./exec";
import { allocateWorkspace, evictOldWorkspaces } from "./workspace";
import { writeBack } from "./writeback";
import type { GitIdentity } from "./clone";
import { hostExec } from "./exec";

const IDENTITY: GitIdentity = { name: "Test Bot", email: "test@factory.local" };

async function seedRepo(dir: string, marker: string): Promise<void> {
  await Bun.$`git init -b main -q ${dir}`.quiet();
  await Bun.$`echo ${marker} > ${join(dir, "seed.txt")}`.quiet();
  await Bun.$`git -C ${dir} add seed.txt`.quiet();
  await Bun.$`git -C ${dir} -c user.name=seed -c user.email=seed@seed.local commit -q -m seed`.quiet();
}

function listRuns(root: string): Array<string> {
  return readdirSync(root).filter((entry) => entry !== ".mirror.git");
}

describe("allocateWorkspace (D28)", () => {
  test("allocates <workspaceRoot>/<runId> from a refreshed bare mirror, with identity set", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    const dir = await allocateWorkspace({
      runId: "run-a",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });

    expect(dir).toBe(join(workspaceRoot, "run-a"));
    expect(existsSync(join(dir, "seed.txt"))).toBe(true);
    expect(existsSync(join(workspaceRoot, ".mirror.git"))).toBe(true);
    const name = (await Bun.$`git -C ${dir} config user.name`.text()).trim();
    expect(name).toBe(IDENTITY.name);
    const email = (await Bun.$`git -C ${dir} config user.email`.text()).trim();
    expect(email).toBe(IDENTITY.email);
    rmSync(root, { recursive: true, force: true });
  });

  test("the mirror is refreshed from the sshUrl before each allocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-refresh-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    await allocateWorkspace({
      runId: "run-one",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });

    await Bun.$`echo two > ${join(seed, "second.txt")}`.quiet();
    await Bun.$`git -C ${seed} add second.txt`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q -m second`.quiet();

    const dir = await allocateWorkspace({
      runId: "run-two",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });
    expect(existsSync(join(dir, "second.txt"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("evicts oldest trees first, retaining the last N", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-evict-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    for (const runId of ["run-1", "run-2", "run-3"]) {
      await allocateWorkspace({
        runId,
        workspaceRoot,
        sshUrl: seed,
        identity: IDENTITY,
        retainedWorkspaces: 2,
      });
    }

    const dirs = listRuns(workspaceRoot).sort();
    expect(dirs).toEqual(["run-2", "run-3"]);
    expect(existsSync(join(workspaceRoot, ".mirror.git"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("allocation is safe under concurrency: two runs get two independent trees", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-concurrent-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    const [a, b] = await Promise.all([
      allocateWorkspace({
        runId: "run-x",
        workspaceRoot,
        sshUrl: seed,
        identity: IDENTITY,
        retainedWorkspaces: 10,
      }),
      allocateWorkspace({
        runId: "run-y",
        workspaceRoot,
        sshUrl: seed,
        identity: IDENTITY,
        retainedWorkspaces: 10,
      }),
    ]);
    expect(existsSync(join(a, "seed.txt"))).toBe(true);
    expect(existsSync(join(b, "seed.txt"))).toBe(true);
    expect([...listRuns(workspaceRoot)].sort()).toEqual(["run-x", "run-y"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("the allocated tree's origin is the configured sshUrl, not the mirror (H1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-origin-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    const dir = await allocateWorkspace({
      runId: "run-a",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });

    const origin = (await Bun.$`git -C ${dir} remote get-url origin`.text()).trim();
    expect(origin).toBe(seed);
    expect(origin).not.toBe(join(workspaceRoot, ".mirror.git"));
    rmSync(root, { recursive: true, force: true });
  });

  test("write-back from an allocated tree pushes to the configured remote, against a bare mirror (H1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-push-test-"));
    const workspaceRoot = join(root, "workspaces");

    const remote = join(root, "remote.git");
    await hostExec(["git", "init", "--bare", remote]);
    const seed = join(root, "seed-repo");
    await Bun.$`git init -b main -q ${seed}`.quiet();
    await Bun.$`echo one > ${join(seed, "seed.txt")}`.quiet();
    await Bun.$`git -C ${seed} add seed.txt`.quiet();
    await Bun.$`git -C ${seed} -c user.name=seed -c user.email=seed@seed.local commit -q -m seed`.quiet();
    await Bun.$`git -C ${seed} push -q ${remote} main`.quiet();

    const dir = await allocateWorkspace({
      runId: "run-a",
      workspaceRoot,
      sshUrl: remote,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });

    writeFileSync(join(dir, "work.ts"), "export const work = 1;\n");
    const exec = (argv: ReadonlyArray<string>) => hostExec(argv, { cwd: dir });
    const result = await writeBack(
      {
        dir,
        branch: "factory/issue-1",
        baseBranch: "main",
        repoSlug: "local/fixture",
        commitMessage: "work happens",
        prTitle: "t",
        prBody: "b",
        runId: "run-a",
      },
      exec,
    );

    expect(result.pushResult.exitCode).toBe(0);
    expect(result.collided).toBe(false);

    const lsRemote = await hostExec(["git", "ls-remote", remote, "refs/heads/factory/issue-1"]);
    expect(lsRemote.stdout).toContain("refs/heads/factory/issue-1");

    const mirrorLs = await hostExec(
      ["git", "ls-remote", join(workspaceRoot, ".mirror.git"), "refs/heads/factory/issue-1"],
      { cwd: root },
    );
    expect(mirrorLs.stdout.trim()).toBe("");
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("eviction never removes a protected entry (an active run's tree) (M2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-protect-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    await allocateWorkspace({
      runId: "run-1",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });
    await Bun.sleep(5);
    await allocateWorkspace({
      runId: "run-2",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });
    await Bun.sleep(5);

    await allocateWorkspace({
      runId: "run-3",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 1,
      protectedEntries: ["run-1"],
    });

    const dirs = listRuns(workspaceRoot).sort();
    expect(dirs).toContain("run-1");
    expect(dirs).toEqual(["run-1", "run-3"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("eviction without protection evicts normally (M2 baseline)", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-protect-base-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    await allocateWorkspace({
      runId: "run-1",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });
    await Bun.sleep(5);
    await allocateWorkspace({
      runId: "run-2",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
    });
    await Bun.sleep(5);

    await allocateWorkspace({
      runId: "run-3",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 1,
    });

    const dirs = listRuns(workspaceRoot).sort();
    expect(dirs).not.toContain("run-1");
    expect(dirs).toEqual(["run-3"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("scratch workspaces (issue #13)", () => {
  test("a scratch allocation is an empty directory: no mirror refresh, no clone", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-scratch-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    const dir = await allocateWorkspace({
      runId: "run-scratch",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
      kind: "scratch",
    });

    expect(dir).toBe(join(workspaceRoot, "run-scratch"));
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(workspaceRoot, ".mirror.git"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("a scratch allocation does not evict or count toward clone retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-scratch-retain-test-"));
    const workspaceRoot = join(root, "workspaces");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    // Two failed-run scratch leftovers, plus one clone.
    for (const runId of ["scratch-1", "scratch-2"]) {
      await allocateWorkspace({
        runId,
        workspaceRoot,
        sshUrl: seed,
        identity: IDENTITY,
        retainedWorkspaces: 10,
        kind: "scratch",
      });
    }
    await allocateWorkspace({
      runId: "clone-1",
      workspaceRoot,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 2,
      scratchEntries: new Set(["scratch-1", "scratch-2"]),
    });

    // retention=2 counted only the one clone: a scratch dir must not evict
    // clone workspaces, and clone allocation must not evict a kept scratch dir.
    expect(listRuns(workspaceRoot).sort()).toEqual(["clone-1", "scratch-1", "scratch-2"]);
    expect(existsSync(join(workspaceRoot, ".mirror.git"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("evictOldWorkspaces scratch exclusion (issue #13)", () => {
  test("scratch entries are neither candidates nor counted toward retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-evict-scratch-test-"));
    const workspaceRoot = join(root, "workspace");
    await Bun.$`mkdir -p ${workspaceRoot}`.quiet();
    for (const name of ["clone-a", "clone-b", "scratch-a", "scratch-b"]) {
      writeFileSync(join(workspaceRoot, name), "x");
    }

    const evicted = await evictOldWorkspaces(workspaceRoot, 2, [], new Set(["scratch-a"]));

    expect(evicted).toEqual(["clone-a"]);
    expect(listRuns(workspaceRoot).sort()).toEqual(["clone-b", "scratch-a", "scratch-b"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("host exec injection (issue #13)", () => {
  test("allocation reaches host command execution through an injected function", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-workspace-exec-seam-test-"));
    const workspaceRoot2 = join(root, "other");
    const seed = join(root, "seed-repo");
    await seedRepo(seed, "one");

    const commands: Array<ReadonlyArray<string | null>> = [];
    // A fake that spawns nothing: if `allocateWorkspace` still called
    // `hostExec` directly, `git clone` would really run and contradict it.
    const exit0: ExecResult = { command: "fake", exitCode: 0, stdout: "", stderr: "" };
    const dir = await allocateWorkspace({
      runId: "run-fake",
      workspaceRoot: workspaceRoot2,
      sshUrl: seed,
      identity: IDENTITY,
      retainedWorkspaces: 10,
      exec: async (argv, opts) => {
        commands.push([...argv, opts?.cwd ?? null]);
        return exit0;
      },
    });

    expect(dir).toBe(join(workspaceRoot2, "run-fake"));
    expect(existsSync(dir)).toBe(false); // a fake exec spawns nothing, clones nothing
    const flat = commands.flat();
    expect(flat.filter((arg) => arg === "clone").length).toBe(2); // mirror + clone
    rmSync(root, { recursive: true, force: true });
  });
});
